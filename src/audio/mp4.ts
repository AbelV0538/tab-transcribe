/**
 * Minimal MP4/MOV demuxer that finds the first audio track and lists its encoded samples,
 * so the audio can be decoded with WebCodecs without relying on the browser's file decoder.
 * Supports regular files (stbl sample tables) and fragmented MP4 (moof/trun), which is what
 * many downloaded social-media videos use.
 */

export interface Mp4AudioSample {
  offset: number;
  size: number;
  /** Decode timestamp in media timescale units. */
  time: number;
  duration: number;
}

export interface Mp4AudioTrack {
  /** WebCodecs codec string, e.g. "mp4a.40.2" (AAC-LC), "mp4a.40.5" (HE-AAC) or "mp3". */
  codec: string;
  /** Human-readable format, used in messages. */
  format: string;
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig for AAC (the WebCodecs `description`); undefined for MP3. */
  description?: Uint8Array;
  timescale: number;
  /** Media time (timescale units) at which playback starts, from the edit list (encoder priming). */
  startTime: number;
  samples: Mp4AudioSample[];
}

export type Mp4Probe =
  | { kind: 'not-mp4' }
  | { kind: 'no-audio' }
  | { kind: 'unsupported'; format: string }
  | { kind: 'audio'; track: Mp4AudioTrack };

interface Box {
  type: string;
  start: number;
  /** Offset of the box payload. */
  body: number;
  end: number;
}

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(o: number) {
    return this.view.getUint8(o);
  }
  u16(o: number) {
    return this.view.getUint16(o);
  }
  u32(o: number) {
    return this.view.getUint32(o);
  }
  i32(o: number) {
    return this.view.getInt32(o);
  }
  u64(o: number) {
    return this.u32(o) * 2 ** 32 + this.u32(o + 4);
  }
  i64(o: number) {
    return this.i32(o) * 2 ** 32 + this.u32(o + 4);
  }
  str(o: number, n: number) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8(o + i));
    return s;
  }

  boxes(start: number, end: number): Box[] {
    const out: Box[] = [];
    let o = start;
    while (o + 8 <= end) {
      let size = this.u32(o);
      const type = this.str(o + 4, 4);
      let body = o + 8;
      if (size === 1) {
        if (o + 16 > end) break;
        size = this.u64(o + 8);
        body = o + 16;
      } else if (size === 0) size = end - o;
      if (size < body - o || o + size > end) break;
      out.push({ type, start: o, body, end: o + size });
      o += size;
    }
    return out;
  }

  child(parent: Box, type: string): Box | undefined {
    return this.boxes(parent.body, parent.end).find((b) => b.type === type);
  }

  path(parent: Box, ...types: string[]): Box | undefined {
    let box: Box | undefined = parent;
    for (const t of types) box = box && this.child(box, t);
    return box;
  }
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AOT_NAMES: Record<number, string> = { 1: 'AAC Main', 2: 'AAC-LC', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'HE-AAC', 29: 'HE-AAC v2', 23: 'AAC-LD', 39: 'AAC-ELD', 42: 'xHE-AAC' };

export interface AudioSpecificConfig {
  objectType: number;
  sampleRate: number;
  channels: number;
  /** Output rate after SBR, when signalled explicitly. */
  extensionSampleRate?: number;
}

/** Parse the start of an MPEG-4 AudioSpecificConfig (ISO/IEC 14496-3). */
export function parseAudioSpecificConfig(asc: Uint8Array): AudioSpecificConfig | null {
  if (asc.length < 2) return null;
  let bit = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) {
      const byte = asc[bit >> 3];
      if (byte === undefined) throw new RangeError('AudioSpecificConfig too short');
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    return v;
  };
  const objectType = () => {
    const t = read(5);
    return t === 31 ? 32 + read(6) : t;
  };
  const rate = () => {
    const i = read(4);
    return i === 15 ? read(24) : (AAC_RATES[i] ?? 0);
  };
  try {
    const aot = objectType();
    const sampleRate = rate();
    const channels = read(4);
    if (aot === 5 || aot === 29) return { objectType: aot, sampleRate, channels, extensionSampleRate: rate() };
    return { objectType: aot, sampleRate, channels };
  } catch {
    return null;
  }
}

/** Read an MPEG-4 descriptor header (tag + variable-length size). */
function descriptor(r: Reader, o: number, end: number): { tag: number; body: number; end: number } | null {
  if (o >= end) return null;
  const tag = r.u8(o++);
  let size = 0;
  for (let i = 0; i < 4 && o < end; i++) {
    const b = r.u8(o++);
    size = (size << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { tag, body: o, end: Math.min(end, o + size) };
}

/** Object type indication and DecoderSpecificInfo from an esds box. */
function parseEsds(r: Reader, esds: Box): { oti: number; dsi?: Uint8Array } | null {
  const es = descriptor(r, esds.body + 4, esds.end); // skip full-box version/flags
  if (!es || es.tag !== 0x03) return null;
  let o = es.body + 2; // ES_ID
  const flags = r.u8(o++);
  if (flags & 0x80) o += 2; // streamDependence
  if (flags & 0x40) o += 1 + r.u8(o); // URL
  if (flags & 0x20) o += 2; // OCR stream
  const dc = descriptor(r, o, es.end);
  if (!dc || dc.tag !== 0x04) return null;
  const oti = r.u8(dc.body);
  const dsi = descriptor(r, dc.body + 13, dc.end);
  return { oti, dsi: dsi && dsi.tag === 0x05 ? r.bytes.slice(dsi.body, dsi.end) : undefined };
}

interface TrackInfo {
  id: number;
  timescale: number;
  startTime: number;
  entry: Omit<Mp4AudioTrack, 'timescale' | 'startTime' | 'samples'> | { unsupported: string };
  stbl?: Box;
}

function parseSampleEntry(r: Reader, stsd: Box): TrackInfo['entry'] {
  const entry = r.boxes(stsd.body + 8, stsd.end)[0];
  if (!entry) return { unsupported: 'unknown' };
  const version = r.u16(entry.body + 8); // QuickTime sound description version
  let channels = r.u16(entry.body + 16);
  let sampleRate = r.u32(entry.body + 24) / 65536;
  let childStart = entry.body + 28;
  if (version === 1) childStart += 16;
  else if (version === 2) {
    sampleRate = r.view.getFloat64(entry.body + 32);
    channels = r.u32(entry.body + 40);
    childStart += 36;
  }
  const fourcc = entry.type;
  if (fourcc === '.mp3') return { codec: 'mp3', format: 'MP3', sampleRate, channels };
  if (fourcc !== 'mp4a') return { unsupported: fourcc.trim() };

  const children = r.boxes(childStart, entry.end);
  const wave = children.find((b) => b.type === 'wave'); // QuickTime wraps esds in 'wave'
  const esds = children.find((b) => b.type === 'esds') ?? (wave && r.child(wave, 'esds'));
  const es = esds && parseEsds(r, esds);
  if (!es) return { unsupported: 'mp4a without esds' };
  if (es.oti === 0x69 || es.oti === 0x6b) return { codec: 'mp3', format: 'MP3', sampleRate, channels };
  if (![0x40, 0x66, 0x67, 0x68].includes(es.oti) || !es.dsi) return { unsupported: `mp4a object type 0x${es.oti.toString(16)}` };
  const asc = parseAudioSpecificConfig(es.dsi);
  if (!asc) return { unsupported: 'invalid AAC config' };
  const format = AOT_NAMES[asc.objectType] ?? `AAC (object type ${asc.objectType})`;
  if (es.oti !== 0x40) return { codec: `mp4a.${es.oti.toString(16)}`, format, sampleRate, channels, description: es.dsi };
  return {
    codec: `mp4a.40.${asc.objectType}`,
    format,
    sampleRate: asc.extensionSampleRate || sampleRate || asc.sampleRate,
    channels: channels || asc.channels,
    description: es.dsi,
  };
}

function sampleTable(r: Reader, stbl: Box): Mp4AudioSample[] {
  const stsz = r.child(stbl, 'stsz');
  const stsc = r.child(stbl, 'stsc');
  const stco = r.child(stbl, 'stco');
  const co64 = r.child(stbl, 'co64');
  const stts = r.child(stbl, 'stts');
  if (!stsz || !stsc || !(stco || co64) || !stts) return [];

  const fixedSize = r.u32(stsz.body + 4);
  const count = r.u32(stsz.body + 8);
  const sizeOf = (i: number) => (fixedSize ? fixedSize : r.u32(stsz.body + 12 + 4 * i));

  const chunks = stco ? r.u32(stco.body + 4) : r.u32(co64!.body + 4);
  const chunkOffset = (c: number) => (stco ? r.u32(stco.body + 8 + 4 * c) : r.u64(co64!.body + 8 + 8 * c));

  const runs: Array<{ firstChunk: number; perChunk: number }> = [];
  const nRuns = r.u32(stsc.body + 4);
  for (let i = 0; i < nRuns; i++) runs.push({ firstChunk: r.u32(stsc.body + 8 + 12 * i) - 1, perChunk: r.u32(stsc.body + 12 + 12 * i) });

  const durations: number[] = [];
  const nTimes = r.u32(stts.body + 4);
  for (let i = 0; i < nTimes && durations.length < count; i++) {
    const n = r.u32(stts.body + 8 + 8 * i);
    const d = r.u32(stts.body + 12 + 8 * i);
    for (let k = 0; k < n && durations.length < count; k++) durations.push(d);
  }

  const samples: Mp4AudioSample[] = [];
  let time = 0;
  for (let run = 0; run < runs.length && samples.length < count; run++) {
    const lastChunk = run + 1 < runs.length ? runs[run + 1].firstChunk : chunks;
    for (let c = runs[run].firstChunk; c < lastChunk && samples.length < count; c++) {
      let offset = chunkOffset(c);
      for (let k = 0; k < runs[run].perChunk && samples.length < count; k++) {
        const i = samples.length;
        const size = sizeOf(i);
        const duration = durations[i] ?? durations[durations.length - 1] ?? 1024;
        samples.push({ offset, size, time, duration });
        offset += size;
        time += duration;
      }
    }
  }
  return samples;
}

/** Samples of `trackId` from all movie fragments (moof + trun). */
function fragmentSamples(r: Reader, top: Box[], moov: Box, trackId: number): Mp4AudioSample[] {
  let defDuration = 0;
  let defSize = 0;
  const mvex = r.child(moov, 'mvex');
  for (const trex of mvex ? r.boxes(mvex.body, mvex.end).filter((b) => b.type === 'trex') : []) {
    if (r.u32(trex.body + 4) !== trackId) continue;
    defDuration = r.u32(trex.body + 12);
    defSize = r.u32(trex.body + 16);
  }
  const samples: Mp4AudioSample[] = [];
  let time = 0;
  for (const moof of top.filter((b) => b.type === 'moof')) {
    for (const traf of r.boxes(moof.body, moof.end).filter((b) => b.type === 'traf')) {
      const tfhd = r.child(traf, 'tfhd');
      if (!tfhd || r.u32(tfhd.body + 4) !== trackId) continue;
      const tf = r.u32(tfhd.body) & 0xffffff;
      let o = tfhd.body + 8;
      let base = moof.start; // default-base-is-moof (and the usual layout otherwise)
      if (tf & 0x01) {
        base = r.u64(o);
        o += 8;
      }
      if (tf & 0x02) o += 4;
      let duration = defDuration;
      let size = defSize;
      if (tf & 0x08) {
        duration = r.u32(o);
        o += 4;
      }
      if (tf & 0x10) {
        size = r.u32(o);
        o += 4;
      }
      const tfdt = r.child(traf, 'tfdt');
      if (tfdt) time = r.u8(tfdt.body) === 1 ? r.u64(tfdt.body + 4) : r.u32(tfdt.body + 4);
      let dataEnd = base;
      for (const trun of r.boxes(traf.body, traf.end).filter((b) => b.type === 'trun')) {
        const flags = r.u32(trun.body) & 0xffffff;
        const n = r.u32(trun.body + 4);
        let p = trun.body + 8;
        let offset = dataEnd;
        if (flags & 0x001) {
          offset = base + r.i32(p);
          p += 4;
        }
        if (flags & 0x004) p += 4; // first-sample-flags
        for (let i = 0; i < n; i++) {
          let d = duration;
          let s = size;
          if (flags & 0x100) {
            d = r.u32(p);
            p += 4;
          }
          if (flags & 0x200) {
            s = r.u32(p);
            p += 4;
          }
          if (flags & 0x400) p += 4;
          if (flags & 0x800) p += 4;
          samples.push({ offset, size: s, time, duration: d });
          offset += s;
          time += d;
        }
        dataEnd = offset;
      }
    }
  }
  return samples;
}

export function probeMp4(bytes: Uint8Array): Mp4Probe {
  const r = new Reader(bytes);
  const top = r.boxes(0, bytes.length);
  if (!top.length || !['ftyp', 'moov', 'free', 'wide', 'mdat', 'skip', 'pnot'].includes(top[0].type)) return { kind: 'not-mp4' };
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return { kind: 'not-mp4' };

  const tracks: TrackInfo[] = [];
  for (const trak of r.boxes(moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const hdlr = r.path(trak, 'mdia', 'hdlr');
    if (!hdlr || r.str(hdlr.body + 8, 4) !== 'soun') continue;
    const tkhd = r.child(trak, 'tkhd');
    const mdhd = r.path(trak, 'mdia', 'mdhd');
    const stbl = r.path(trak, 'mdia', 'minf', 'stbl');
    const stsd = stbl && r.child(stbl, 'stsd');
    if (!tkhd || !mdhd || !stsd) continue;
    const id = r.u32(tkhd.body + (r.u8(tkhd.body) === 1 ? 20 : 12));
    const timescale = r.u32(mdhd.body + (r.u8(mdhd.body) === 1 ? 20 : 12));
    // First non-empty edit: its media time is where playback starts (skips encoder priming).
    let startTime = 0;
    const elst = r.path(trak, 'edts', 'elst');
    if (elst) {
      const v = r.u8(elst.body);
      const n = r.u32(elst.body + 4);
      for (let i = 0, p = elst.body + 8; i < n; i++, p += v === 1 ? 20 : 12) {
        const mediaTime = v === 1 ? r.i64(p + 8) : r.i32(p + 4);
        if (mediaTime >= 0) {
          startTime = mediaTime;
          break;
        }
      }
    }
    tracks.push({ id, timescale, startTime, entry: parseSampleEntry(r, stsd), stbl });
  }
  if (tracks.length === 0) return { kind: 'no-audio' };
  const track = tracks.find((t) => !('unsupported' in t.entry)) ?? tracks[0];
  if ('unsupported' in track.entry) return { kind: 'unsupported', format: track.entry.unsupported };

  let samples = track.stbl ? sampleTable(r, track.stbl) : [];
  if (samples.length === 0) samples = fragmentSamples(r, top, moov, track.id);
  samples = samples.filter((s) => s.size > 0 && s.offset + s.size <= bytes.length);
  if (samples.length === 0) return { kind: 'no-audio' };
  return { kind: 'audio', track: { ...track.entry, timescale: track.timescale, startTime: track.startTime, samples } };
}
