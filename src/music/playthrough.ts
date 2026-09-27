/**
 * Corrections from a playthrough video: where the fretting hand is (from src/vision) constrains
 * which notes the filmed instrument can be playing and where on the neck they are played.
 */
import type { RawNote } from '../engine/types';
import type { InstrumentKind, Tuning } from './tunings';

/** Fret spaces covered by the fretting hand at a moment (lo = 0: at the nut / open position). */
export interface HandHint {
  time: number;
  lo: number;
  hi: number;
  confidence: number;
}

export interface Playthrough {
  instrument: InstrumentKind;
  /** Sorted by time. */
  hints: HandHint[];
}

/** Hints below this confidence are ignored. */
const MIN_CONFIDENCE = 0.3;

/**
 * The hand window for a note starting at `time`: the most confident hint from shortly before
 * the onset (the finger is placed first) to shortly after it.
 */
export function hintAt(hints: HandHint[], time: number): HandHint | null {
  let lo = 0;
  let hi = hints.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hints[mid].time < time - 0.08) lo = mid + 1;
    else hi = mid;
  }
  let best: HandHint | null = null;
  for (let i = lo; i < hints.length && hints[i].time <= time + 0.15; i++) {
    if (hints[i].confidence >= MIN_CONFIDENCE && (!best || hints[i].confidence > best.confidence)) best = hints[i];
  }
  return best;
}

/** Frets by which fretting `fret` misses the hand window (open strings never miss). */
export function fretMiss(fret: number, hint: HandHint): number {
  if (fret === 0) return 0;
  return fret < hint.lo ? hint.lo - fret : fret > hint.hi ? fret - hint.hi : 0;
}

/** Smallest window miss over every string that can play `pitch` (Infinity if none can). */
export function pitchMiss(pitch: number, tuning: Tuning, capo: number, frets: number, hint: HandHint): number {
  let best = Infinity;
  for (const open of tuning.strings) {
    const fret = pitch - (open + capo);
    if (fret < 0 || fret > frets - capo) continue;
    best = Math.min(best, fretMiss(fret, hint));
  }
  return best;
}

export interface CorrectionResult {
  notes: RawNote[];
  /** Per note: weight for instrument assignment (>1 fits the hand, <1 doesn't). */
  weights: number[];
  /** Notes moved by an octave to fit the hand position. */
  octaveFixes: number;
  /** Notes with a usable hand position. */
  covered: number;
}

/**
 * Check every note in the filmed instrument's range against the hand position. A note the
 * hand can't be playing is moved by an octave if that fits (the note detector often reports
 * a bass note an octave off), otherwise it is down-weighted.
 */
export function correctWithHands(
  notes: RawNote[],
  playthrough: Playthrough,
  tuning: Tuning,
  capo: number,
  frets: number,
): CorrectionResult {
  const low = tuning.strings[0] + capo;
  const high = tuning.strings[tuning.strings.length - 1] + frets;
  let octaveFixes = 0;
  let covered = 0;
  const weights: number[] = [];
  const out = notes.map((n) => {
    const hint = hintAt(playthrough.hints, n.start);
    if (!hint || n.pitch < low - 12 || n.pitch > high + 12) {
      weights.push(1);
      return n;
    }
    covered++;
    const miss = pitchMiss(n.pitch, tuning, capo, frets, hint);
    if (miss <= 1) {
      weights.push(1 + 0.5 * hint.confidence);
      return n;
    }
    for (const alt of [n.pitch - 12, n.pitch + 12]) {
      if (alt >= low && alt <= high && pitchMiss(alt, tuning, capo, frets, hint) === 0) {
        octaveFixes++;
        weights.push(1 + 0.3 * hint.confidence);
        return { ...n, pitch: alt };
      }
    }
    weights.push(Math.max(0.15, 1 - 0.8 * hint.confidence));
    return n;
  });
  return { notes: out, weights, octaveFixes, covered };
}
