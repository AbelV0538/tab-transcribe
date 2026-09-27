/** Decode an MP4/MOV audio track (found by ./mp4) with the WebCodecs AudioDecoder. */
import type { Mp4AudioTrack } from './mp4';

export function webCodecsAvailable(): boolean {
  return typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined';
}

/** Returns mono PCM at the decoder's output rate (e.g. 44.1 kHz for HE-AAC). */
export async function decodeWithWebCodecs(
  bytes: Uint8Array,
  track: Mp4AudioTrack,
  onProgress: (fraction: number) => void = () => {},
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const config: AudioDecoderConfig = {
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    ...(track.description ? { description: track.description } : {}),
  };
  const support = await AudioDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`${track.format} is not supported by WebCodecs in this browser`);

  const chunks: Float32Array[] = [];
  let rate = 0;
  let failure: unknown = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        rate = data.sampleRate;
        const n = data.numberOfFrames;
        const mono = new Float32Array(n);
        const plane = new Float32Array(n);
        for (let c = 0; c < data.numberOfChannels; c++) {
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let i = 0; i < n; i++) mono[i] += plane[i] / data.numberOfChannels;
        }
        chunks.push(mono);
      } catch (err) {
        failure = err;
      } finally {
        data.close();
      }
    },
    error: (err) => {
      failure = err;
    },
  });

  try {
    decoder.configure(config);
    const us = (t: number) => Math.round((t * 1e6) / track.timescale);
    const n = track.samples.length;
    for (let i = 0; i < n && !failure; i++) {
      const s = track.samples[i];
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: us(s.time), duration: us(s.duration), data: bytes.subarray(s.offset, s.offset + s.size) }));
      // Back-pressure: let the queue drain before feeding more.
      if (decoder.decodeQueueSize > 48) {
        while (decoder.decodeQueueSize > 8 && !failure) await new Promise((r) => setTimeout(r, 0));
        onProgress(i / n);
      }
    }
    if (!failure) await decoder.flush();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));

  const total = chunks.reduce((s, c) => s + c.length, 0);
  // Drop encoder priming, as signalled by the edit list (like the browser's own decoder does).
  const skip = Math.min(total, Math.round((track.startTime * rate) / track.timescale));
  const samples = new Float32Array(total - skip);
  let o = -skip;
  for (const c of chunks) {
    if (o + c.length > 0) samples.set(o >= 0 ? c : c.subarray(-o), Math.max(0, o));
    o += c.length;
  }
  onProgress(1);
  return { samples, sampleRate: rate };
}
