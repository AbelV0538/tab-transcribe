/** Synthetic test recordings (WAV encoder and songs) built on the app's string synth. */
import type { SynthNote } from '../../src/audio/synth';
export { synthesize, type SynthNote } from '../../src/audio/synth';

/** 16-bit PCM mono WAV encoder. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(buf);
}

/** Test songs at 120 BPM (beat = 0.5 s) starting on beat 1 at t = 0.5 s. */
export const BEAT = 0.5;
export const T0 = 0.5;

export function bassSong(bars = 4): SynthNote[] {
  // Eighth notes: E1 E1 G1 A1 | B1 A1 G1 F#1 ... root-based rock line.
  const pattern = [28, 28, 31, 33, 35, 33, 31, 30];
  const out: SynthNote[] = [];
  for (let i = 0; i < bars * 8; i++) {
    const start = T0 + (i * BEAT) / 2;
    out.push({ pitch: pattern[i % pattern.length], start, end: start + BEAT / 2 - 0.02, instrument: 'bass' });
  }
  return out;
}

export const GUITAR_SHAPES = [
  [40, 47, 52, 56, 59, 64], // E
  [45, 52, 57, 60, 64], // Am
  [43, 47, 50, 55, 59, 67], // G
  [50, 57, 62, 66], // D
];

export function guitarChordSong(bars = 4): SynthNote[] {
  // One strummed chord per half bar (two beats), strum spread 10 ms per string.
  const out: SynthNote[] = [];
  for (let i = 0; i < bars * 2; i++) {
    const shape = GUITAR_SHAPES[Math.floor(i / 2) % GUITAR_SHAPES.length];
    const start = T0 + i * 2 * BEAT;
    shape.forEach((p, k) => out.push({ pitch: p, start: start + k * 0.01, end: start + 2 * BEAT - 0.05, instrument: 'guitar', velocity: 0.7 }));
  }
  return out;
}

export function guitarMelodySong(bars = 4): SynthNote[] {
  // Eighth-note melody in A minor pentatonic (5th position).
  const pattern = [57, 60, 62, 64, 67, 64, 62, 60, 69, 67, 64, 62, 60, 62, 64, 57];
  const out: SynthNote[] = [];
  for (let i = 0; i < bars * 8; i++) {
    const start = T0 + (i * BEAT) / 2;
    out.push({ pitch: pattern[i % pattern.length], start, end: start + BEAT / 2 - 0.02, instrument: 'guitar' });
  }
  return out;
}
