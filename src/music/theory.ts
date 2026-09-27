export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);

export function pitchClassName(midi: number, flats = false): string {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  return (flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[pc];
}

/** Scientific pitch notation, e.g. 40 → "E2". */
export function noteName(midi: number, flats = false): string {
  return `${pitchClassName(midi, flats)}${Math.floor(Math.round(midi) / 12) - 1}`;
}

/** Diatonic step and alteration for MusicXML (sharps spelling). */
export function pitchSpelling(midi: number): { step: string; alter: number; octave: number } {
  const name = pitchClassName(midi);
  return { step: name[0], alter: name.length > 1 ? 1 : 0, octave: Math.floor(midi / 12) - 1 };
}

const CHORD_TYPES: Array<{ suffix: string; intervals: number[] }> = [
  { suffix: '', intervals: [0, 4, 7] },
  { suffix: 'm', intervals: [0, 3, 7] },
  { suffix: '7', intervals: [0, 4, 7, 10] },
  { suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { suffix: 'm7', intervals: [0, 3, 7, 10] },
  { suffix: 'sus4', intervals: [0, 5, 7] },
  { suffix: 'sus2', intervals: [0, 2, 7] },
  { suffix: 'dim', intervals: [0, 3, 6] },
  { suffix: 'aug', intervals: [0, 4, 8] },
  { suffix: 'add9', intervals: [0, 2, 4, 7] },
  { suffix: '6', intervals: [0, 4, 7, 9] },
  { suffix: 'm6', intervals: [0, 3, 7, 9] },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10] },
  { suffix: '5', intervals: [0, 7] },
];

/**
 * Name the chord formed by a set of MIDI pitches (e.g. [40, 47, 52, 56, 59, 64] → "E").
 * Returns null for fewer than two distinct pitch classes or unrecognised sets.
 */
export function chordName(pitches: number[]): string | null {
  if (pitches.length < 2) return null;
  const pcs = [...new Set(pitches.map((p) => ((p % 12) + 12) % 12))];
  if (pcs.length < 2) return null;
  const bass = ((Math.min(...pitches) % 12) + 12) % 12;
  let best: { name: string; score: number } | null = null;
  for (const root of pcs) {
    const rel = new Set(pcs.map((pc) => (pc - root + 12) % 12));
    for (const type of CHORD_TYPES) {
      if (!type.intervals.every((i) => rel.has(i))) continue;
      if (rel.size !== type.intervals.length) continue;
      // Prefer root position and simpler chords.
      const score = (root === bass ? 2 : 0) - type.intervals.length * 0.1;
      const name = pitchClassName(root) + type.suffix + (root !== bass ? `/${pitchClassName(bass)}` : '');
      if (!best || score > best.score) best = { name, score };
    }
  }
  return best?.name ?? null;
}
