/**
 * Decode an audio or video file into mono PCM at the model's sample rate.
 *
 * The browser's own decoder (`decodeAudioData`) handles the audio track of common video
 * containers (MP4/MOV/M4V, WebM/MKV) as well as MP3, AAC, WAV, FLAC and Ogg. When it refuses
 * a file, we fall back to playing it silently through a media element and recording the
 * output, which works for anything the platform's media player can play.
 */

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
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
  onProgress('Reading file', 0);
  const data = await file.arrayBuffer();
  onProgress('Decoding audio', 0);
  let buffer: AudioBuffer | null = null;
  try {
    // Decoding into an offline context at the target rate also resamples.
    const Ctor = offlineCtor();
    buffer = await decodeWith(new Ctor(1, 1, targetRate), data);
  } catch {
    buffer = null;
  }
  if (buffer && buffer.length > 0) {
    let samples = mixToMono(buffer);
    if (buffer.sampleRate !== targetRate) samples = await resample(samples, buffer.sampleRate, targetRate);
    onProgress('Decoding audio', 1);
    return { samples, sampleRate: targetRate, duration: samples.length / targetRate };
  }
  if (!fallbackContext) throw new Error('This file format could not be decoded on this device.');
  const recorded = await recordThroughMediaElement(file, fallbackContext, (f) => onProgress('Extracting audio track', f));
  const samples = await resample(recorded.samples, recorded.sampleRate, targetRate);
  return { samples, sampleRate: targetRate, duration: samples.length / targetRate };
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
