import type { RawNote } from '../../src/engine/types';

export function note(pitch: number, start: number, dur = 0.4, amplitude = 0.7, fd: number | null = null): RawNote {
  return {
    pitch,
    start,
    end: start + dur,
    amplitude,
    features: { fundamentalDominance: fd, harmonicCentroid: null, attack: 5, cents: 0, onsetStrength: 1 },
  };
}

/** Bass line (E1-based, monophonic) with a strong fundamental. */
export function bassLine(startAt = 0, beat = 0.5, bars = 4): RawNote[] {
  const pattern = [28, 28, 31, 33, 35, 33, 31, 30];
  const out: RawNote[] = [];
  for (let i = 0; i < bars * 4; i++) out.push(note(pattern[i % pattern.length], startAt + i * beat, beat * 0.9, 0.75, 0.7));
  return out;
}

/** Strummed guitar chords (E, A, D, B7 open shapes) on every other beat. */
export function guitarChords(startAt = 0, beat = 0.5, bars = 4): RawNote[] {
  const shapes = [
    [40, 47, 52, 56, 59, 64],
    [45, 52, 57, 61, 64],
    [50, 57, 62, 66],
    [47, 51, 57, 59, 66],
  ];
  const out: RawNote[] = [];
  for (let i = 0; i < bars * 2; i++) {
    const shape = shapes[i % shapes.length];
    shape.forEach((p, k) => out.push(note(p, startAt + i * 2 * beat + k * 0.008, beat * 1.8, 0.6, 0.25)));
  }
  return out;
}

/** Single-note guitar riff on the low strings (E2-A2 region). */
export function guitarRiff(startAt = 0, step = 0.25, count = 32): RawNote[] {
  const pattern = [40, 43, 45, 40, 47, 45, 43, 42];
  return Array.from({ length: count }, (_, i) => note(pattern[i % pattern.length], startAt + i * step, step * 0.9, 0.7, 0.3));
}

/** Guitar melody in the upper register. */
export function guitarMelody(startAt = 0, step = 0.25, count = 24): RawNote[] {
  const pattern = [64, 67, 69, 71, 72, 71, 69, 67, 76, 74, 72, 71];
  return Array.from({ length: count }, (_, i) => note(pattern[i % pattern.length], startAt + i * step, step * 0.9, 0.7, 0.3));
}
