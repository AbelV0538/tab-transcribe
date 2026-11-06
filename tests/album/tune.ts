/**
 * Fits the guitar fingering weights to the album tabs by coordinate descent, with songs held
 * out for validation. Weight sets that break the general-purpose expectations of
 * tests/fingering.test.ts (open-position scale and chords, barre chords, staying in position)
 * are rejected, so the fit can't trade those away for this one band's style.
 */
import { assignFingerings, GUITAR_WEIGHTS, type FingeringWeights, type NoteIn } from '../../src/music/fingering';
import { GUITAR_TUNINGS } from '../../src/music/tunings';
import type { AlbumSong } from './dataset';
import { runSong, summarise, type TrackResult } from './oracle';

const guitar = { tuning: GUITAR_TUNINGS[0], instrument: 'guitar' as const, frets: 22, capo: 0 };
const seq = (pitches: number[], step = 0.25): NoteIn[] => pitches.map((p, i) => ({ pitch: p, start: i * step, end: i * step + step * 0.9, amplitude: 0.8 }));
const chord = (pitches: number[]): NoteIn[] => pitches.map((p) => ({ pitch: p, start: 0, end: 1, amplitude: 0.8 }));

/** The guitar expectations of tests/fingering.test.ts. */
export function passesGuards(weights: Partial<FingeringWeights>): boolean {
  const pos = (notes: NoteIn[], capo = 0) => assignFingerings(notes, { ...guitar, capo, weights }).notes.map((n) => `${n.string}:${n.fret}`).join(' ');
  if (pos(seq([48, 50, 52, 53, 55, 57, 59, 60])) !== '1:3 2:0 2:2 2:3 3:0 3:2 4:0 4:1') return false;
  if (pos(chord([43, 47, 50, 55, 59, 67])) !== '0:3 1:2 2:0 3:0 4:0 5:3') return false;
  if (pos(chord([40, 47, 52])) !== '0:0 1:2 2:2') return false;
  if (pos(chord([41, 48, 53, 57, 60, 65])) !== '0:1 1:3 2:3 3:2 4:1 5:1') return false;
  if (pos(chord([42, 49, 54]), 2) !== '0:0 1:2 2:2') return false;
  const lick = assignFingerings(seq([76, 79, 81, 79, 76, 74, 72, 69], 0.12), { ...guitar, weights }).notes.map((n) => n.fret);
  if (Math.min(...lick) < 10 || Math.max(...lick) - Math.min(...lick) > 5) return false;
  return true;
}

/** Weights the tuner may change, with the values tried for a weight that is currently 0. */
export const TUNABLE: Array<keyof FingeringWeights> = [
  'fretHeight',
  'openSingle',
  'openChordHigh',
  'openChordLow',
  'shiftBase',
  'shiftPerFret',
  'shiftFast',
  'shiftSlow',
  'stringSkip',
  'repeatPitchMove',
  'ringCut',
  'stretch1',
  'stretch2',
  'barre',
  'mutedInner',
  'highFret',
  'stringChangeStep',
  'stringChangeThird',
  'stringChangeFourth',
  'stringChangeFast',
];
const FROM_ZERO = [0.1, 0.3, 0.6, 1.2];

/**
 * The hand-set guitar weights from before any fitting. Cross-validation starts here, so
 * held-out scores never benefit from weights that were fitted on the held-out songs.
 */
export const HAND_SET_WEIGHTS: Partial<FingeringWeights> = {
  stretch1: 1.5,
  stretch2: 4,
  barre: 0.5,
  flatBarre: 0.3,
  fretHeight: 0.04,
  highFret: 0.1,
  openSingle: 0.35,
  openChordHigh: 0.2,
  openChordLow: 0.2,
  mutedInner: 0.4,
  shiftBase: 1,
  shiftPerFret: 0.35,
  shiftFast: 1.5,
  shiftSlow: 0.6,
  stringSkip: 0.1,
  repeatPitchMove: 0.8,
  ringCut: 0.3,
  handMiss: 1.5,
  stringChangeStep: 0,
  stringChangeThird: 0,
  stringChangeFourth: 0,
  stringChangeFast: 0,
  chordSustain: -Infinity,
};
const MULTIPLIERS = [0, 0.5, 0.7, 1.4, 2];
const SUSTAIN = [-Infinity, 0, 0.02, 0.04];

export function evaluate(songs: AlbumSong[], weights: Partial<FingeringWeights>): { songAccuracy: number; accuracy: number; results: TrackResult[] } {
  const results = songs.flatMap((s) => runSong(s, { weights }));
  const sum = summarise(results);
  return { songAccuracy: sum.songAccuracy, accuracy: sum.accuracy, results };
}

export interface FitLog {
  (line: string): void;
}

/** Coordinate descent from `start`, maximising mean per-song accuracy on `songs`. */
export function fit(songs: AlbumSong[], start: Partial<FingeringWeights>, log: FitLog, maxSweeps = 6): { weights: Partial<FingeringWeights>; score: number } {
  let best: Partial<FingeringWeights> = { ...start };
  let bestScore = evaluate(songs, best).songAccuracy;
  log(`  start ${(100 * bestScore).toFixed(2)}%`);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let improved = false;
    const tryValue = (key: keyof FingeringWeights, value: number) => {
      const w = { ...best, [key]: value };
      if (!passesGuards(w)) return;
      const score = evaluate(songs, w).songAccuracy;
      if (score > bestScore + 1e-4) {
        log(`  ${key}: ${fmt(best[key] ?? GUITAR_WEIGHTS[key])} → ${fmt(value)}  ${(100 * score).toFixed(2)}%`);
        best = w;
        bestScore = score;
        improved = true;
      }
    };
    for (const key of TUNABLE) {
      const cur = (best[key] ?? GUITAR_WEIGHTS[key]) as number;
      const values = cur === 0 ? FROM_ZERO : MULTIPLIERS.map((m) => Math.round(cur * m * 1000) / 1000);
      for (const v of new Set(values)) if (v !== cur) tryValue(key, v);
    }
    const sustain = best.chordSustain ?? GUITAR_WEIGHTS.chordSustain;
    for (const v of SUSTAIN) if (v !== sustain) tryValue('chordSustain', v);
    log(`  sweep ${sweep + 1}: ${(100 * bestScore).toFixed(2)}%`);
    if (!improved) break;
  }
  return { weights: best, score: bestScore };
}

const fmt = (v: unknown) => (typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(v)) : String(v));
