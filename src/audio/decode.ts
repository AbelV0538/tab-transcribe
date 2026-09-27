/**
 * Decode an audio or video file into mono PCM at the model's sample rate.
 *
 * Three decoders are tried in turn, and each result is checked: a decoder that returns
 * silence for a file that has sound in it counts as a failure, not as a quiet recording.
 *  1. The browser's file decoder (`decodeAudioData`): MP3, AAC, WAV, FLAC, Ogg and the audio
 *     track of MP4/MOV/M4V and WebM/MKV videos.
 *  2. For MP4/MOV/M4A: our own demuxer (./mp4) plus the WebCodecs AudioDecoder.
 *  3. Playing the file silently through a media element and recording the output, which
 *     works for anything the platform's media player can play.
 */
import { probeMp4, type Mp4Probe } from './mp4';
import { decodeWithWebCodecs, webCodecsAvailable } from './webcodecs';

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  /** Which decoder produced the audio (for diagnostics). */
  decoder: string;
}

/** A peak below this (-80 dBFS) is digital silence: the decoder produced no real audio. */
const SILENCE_PEAK = 1e-4;

function peakOf(samples: Float32Array): number {
  let m = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > m) m = v;
  }
  return m;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err ?? 'unknown error');
}

type OfflineCtor = typeof OfflineAudioContext;

function offlineCtor(): OfflineCtor {
  const w = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!ctor) throw new Error('This browser does not support the Web Audio API');
  return ctor;
}

function decodeWith(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    // Callback form for older WebKit; promise form everywhere else.
    const maybe = ctx.decodeAudioData(data, resolve, (e) => reject(e ?? new Error('decode failed')));
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
  });
}

export function mixToMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / channels;
  }
  return out;
}

/** Resample mono PCM with the browser's resampler (via an offline render). */
async function resample(samples: Float32Array, fromRate: number, toRate: number): Promise<Float32Array> {
  if (fromRate === toRate) return samples;
  const Ctor = offlineCtor();
  const length = Math.max(1, Math.ceil((samples.length * toRate) / fromRate));
  const ctx = new Ctor(1, length, toRate);
  const buf = ctx.createBuffer(1, samples.length, fromRate);
  buf.getChannelData(0).set(samples);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

export async function decodeFile(
  file: Blob,
  targetRate: number,
  onProgress: (stage: string, fraction: number) => void = () => {},
  fallbackContext?: AudioContext,
): Promise<DecodedAudio> {
  const attempts: string[] = [];
  const accept = (samples: Float32Array, decoder: string): DecodedAudio | null => {
    const peak = peakOf(samples);
    const duration = samples.length / targetRate;
    console.info(`[decode] ${decoder}: ${duration.toFixed(1)} s, peak ${(20 * Math.log10(peak + 1e-12)).toFixed(1)} dBFS`);
    if (duration < 0.05) attempts.push(`${decoder}: no audio`);
    else if (peak < SILENCE_PEAK) attempts.push(`${decoder}: decoded to silence`);
    else return { samples, sampleRate: targetRate, duration, decoder };
    return null;
  };

  // 1. The browser's file decoder. Decoding into an offline context at the target rate also resamples.
  onProgress('Reading file', 0);
  let data: ArrayBuffer | null = await file.arrayBuffer();
  onProgress('Decoding audio', 0);
  try {
    const buffer = await decodeWith(new (offlineCtor())(1, 1, targetRate), data);
    let samples = mixToMono(buffer);
    if (buffer.sampleRate !== targetRate) samples = await resample(samples, buffer.sampleRate, targetRate);
    const ok = accept(samples, 'Web Audio');
    if (ok) return ok;
  } catch (err) {
    attempts.push(`Web Audio: ${describeError(err)}`);
  }

  // 2. MP4/MOV: demux here and decode with WebCodecs. (decodeAudioData detached `data`.)
  data = await file.arrayBuffer();
  const probe: Mp4Probe = probeMp4(new Uint8Array(data));
  if (probe.kind === 'no-audio') throw new Error('This video has no audio track, so there is nothing to transcribe.');
  if (probe.kind === 'unsupported') attempts.push(`MP4 demuxer: audio format "${probe.format}" not supported`);
  if (probe.kind === 'audio') {
    if (!webCodecsAvailable()) attempts.push('WebCodecs: not available in this browser');
    else {
      try {
        onProgress('Decoding audio track', 0);
        const decoded = await decodeWithWebCodecs(new Uint8Array(data), probe.track, (f) => onProgress('Decoding audio track', f));
        const ok = accept(await resample(decoded.samples, decoded.sampleRate, targetRate), `WebCodecs (${probe.track.format})`);
        if (ok) return ok;
      } catch (err) {
        attempts.push(`WebCodecs: ${describeError(err)}`);
      }
    }
  }
  data = null;

  // 3. Play the file through a media element and record what comes out.
  if (fallbackContext) {
    try {
      const recorded = await recordThroughMediaElement(file, fallbackContext, (f) => onProgress('Extracting audio track', f));
      const ok = accept(await resample(recorded.samples, recorded.sampleRate, targetRate), 'media element');
      if (ok) return ok;
    } catch (err) {
      attempts.push(`media element: ${describeError(err)}`);
    }
  }

  console.warn('[decode] no decoder produced audio:', attempts);
  const format = probe.kind === 'audio' ? ` (${probe.track.format}, ${probe.track.sampleRate / 1000} kHz)` : '';
  throw new Error(
    `No sound could be decoded from this file's audio track${format}: it is either silent, or this browser can't decode it. ` +
      'If it plays with sound in other apps, try another browser or convert it to MP3 or WAV. ' +
      `[Tried: ${attempts.join('; ')}]`,
  );
}

/**
 * Fallback: play the file (inaudibly) through a media element at double speed without
 * pitch correction and capture the stream. Played at rate r, the captured signal is the
 * original sampled at (contextRate / r).
 */
async function recordThroughMediaElement(
  file: Blob,
  ctx: AudioContext,
  onProgress: (fraction: number) => void,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const url = URL.createObjectURL(file);
  const el = document.createElement(file.type.startsWith('video') ? 'video' : 'audio');
  el.src = url;
  el.preload = 'auto';
  (el as HTMLMediaElement & { playsInline?: boolean }).playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve();
      el.onerror = () => reject(new Error('This file format is not supported on this device.'));
    });
    const rate = 2;
    const pitchEl = el as HTMLMediaElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
    pitchEl.preservesPitch = false;
    pitchEl.webkitPreservesPitch = false;
    pitchEl.mozPreservesPitch = false;
    el.playbackRate = rate;

    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaElementSource(el);
    const processor = ctx.createScriptProcessor(4096, 2, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (e) => {
      if (el.paused) return;
      const input = e.inputBuffer;
      const mono = new Float32Array(input.length);
      for (let c = 0; c < input.numberOfChannels; c++) {
        const d = input.getChannelData(c);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / input.numberOfChannels;
      }
      chunks.push(mono);
      if (isFinite(el.duration) && el.duration > 0) onProgress(Math.min(1, el.currentTime / el.duration));
    };
    source.connect(processor);
    processor.connect(silent);
    silent.connect(ctx.destination);
    await new Promise<void>((resolve, reject) => {
      el.onended = () => resolve();
      el.onerror = () => reject(new Error('Playback failed while extracting audio.'));
      el.play().catch(reject);
    });
    source.disconnect();
    processor.disconnect();
    silent.disconnect();
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const samples = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      samples.set(c, o);
      o += c.length;
    }
    return { samples, sampleRate: ctx.sampleRate / rate };
  } finally {
    URL.revokeObjectURL(url);
    el.removeAttribute('src');
  }
}
