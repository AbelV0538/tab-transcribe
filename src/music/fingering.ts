/**
 * Fretboard fingering optimiser.
 *
 * Every pitch can be played at several string/fret positions. We pick the sequence of
 * positions that a player would most plausibly use by minimising, with a Viterbi search,
 * the sum of:
 *  - static costs of each chord shape / single position (finger stretch, number of fingers
 *    and barres, fret height, muted strings inside a strummed chord, open-string ease), and
 *  - transition costs between consecutive events (hand shifts along the neck weighted by how
 *    fast they must happen, string skips, re-fingering a repeated pitch, cutting off a string
 *    that is still ringing).
 * The hand position is carried along each path so that open strings do not reset it.
 */
import { fretMiss, type HandHint } from './playthrough';
import type { InstrumentKind, Tuning } from './tunings';

export interface NoteIn {
  pitch: number;
  start: number;
  end: number;
  amplitude: number;
}

export interface FingeredNote<N extends NoteIn = NoteIn> {
  note: N;
  /** Pitch actually placed on the fretboard (differs from note.pitch when octave-folded). */
  pitch: number;
  /** String index, 0 = lowest string. */
  string: number;
  /** Fret relative to the capo (0 = open / capo). */
  fret: number;
  /** True when the note had to be moved by octaves to fit the instrument's range. */
  folded: boolean;
}

export interface FingeringOptions {
  tuning: Tuning;
  instrument: InstrumentKind;
  /** Highest fret on the neck (absolute, not relative to the capo). */
  frets: number;
  capo: number;
  /** Where the fretting hand was at a given time (from a playthrough video), if known. */
  hand?: (time: number) => HandHint | null;
  /** Overrides for the instrument's default cost weights (used by the benchmark tuner). */
  weights?: Partial<FingeringWeights>;
}

/**
 * Weights of the fingering cost model. Costs are in arbitrary units; a hand shift costs about
 * 1 + 0.35 per fret. Bonuses (open strings) are given as positive numbers that are subtracted.
 */
export interface FingeringWeights {
  /** Span one fret beyond the comfortable hand window. */
  stretch1: number;
  /** Span two frets beyond the comfortable hand window. */
  stretch2: number;
  /** Per fret beyond that (Infinity: such shapes are never used). */
  stretchBeyond: number;
  /** Barre plus fingers above it. */
  barre: number;
  /** Flat barre across three or more strings. */
  flatBarre: number;
  /** Per fret of the lowest fretted note (prefers lower positions). */
  fretHeight: number;
  /** Per fret above `highFretFrom`. */
  highFret: number;
  highFretFrom: number;
  /** Bonus for a single note on an open string. */
  openSingle: number;
  /** Per open string in a chord whose fretted notes are at the 5th fret or higher. */
  openChordHigh: number;
  /** Bonus per open string in a chord in a low position. */
  openChordLow: number;
  /** Per unplayed string between played strings in a chord of three or more notes. */
  mutedInner: number;
  /** A single note above the 9th fret on the thinnest string. */
  thinStringHigh: number;
  /** Hand shift: base cost and cost per fret moved. */
  shiftBase: number;
  shiftPerFret: number;
  /** Shift cost multiplier when there is less than 120 ms / more than 600 ms to shift. */
  shiftFast: number;
  shiftSlow: number;
  /** Per string skipped between consecutive single notes (beyond the adjacent string). */
  stringSkip: number;
  /** Playing a repeated pitch at a different position. */
  repeatPitchMove: number;
  /** Re-using a string that is still ringing. */
  ringCut: number;
  /** Per fret a fretted note lies outside the filmed hand position (× confidence). */
  handMiss: number;
  /**
   * Changing string between consecutive single notes a step (1-2 semitones), a third (3-4) or
   * a fourth/fifth (5-7) apart. Players run scales and slide along one string.
   */
  stringChangeStep: number;
  stringChangeThird: number;
  stringChangeFourth: number;
  /**
   * Extra cost for changing string between single notes up to a third apart that follow within
   * 100 ms: hammer-ons, pull-offs, slides and grace notes stay on one string.
   */
  stringChangeFast: number;
  /**
   * Notes starting within the chord window join a chord only if every note already in it is
   * still sounding this many seconds after their onset: strummed notes ring together, while
   * grace notes and fast runs end as the next note starts. -Infinity: always join.
   */
  chordSustain: number;
  /**
   * Leaving a note out of the tab costs this much times its confidence (amplitude relative to
   * the track's typical note). A weak note that would force an awkward stretch or a
   * jump across the neck is then dropped rather than fingered: it is usually another
   * instrument, an overtone or a second guitar. Infinity: never drop playable notes.
   */
  dropNote: number;
}

/**
 * Guitar weights fitted to professional tabs: the RTYWD album benchmark (tests/album), by
 * coordinate descent with songs held out (tests/tune.album.test.ts), and constrained by the
 * open-position expectations in tests/fingering.test.ts. Compared with the earlier hand-set
 * values, players don't prefer low frets, pay for hand shifts by distance, keep runs and
 * hammer-ons on one string, and use open strings less in low-position chords.
 * (mutedInner was capped at 3: the fit's 17.9 is "never", for 0.2 points of accuracy.)
 */
export const GUITAR_WEIGHTS: FingeringWeights = {
  stretch1: 0.1,
  stretch2: 0.98,
  stretchBeyond: Infinity,
  barre: 0,
  flatBarre: 0.3,
  fretHeight: 0,
  highFret: 0.784,
  highFretFrom: 15,
  openSingle: 0.49,
  openChordHigh: 0,
  openChordLow: 0,
  mutedInner: 3,
  thinStringHigh: 0,
  shiftBase: 0,
  shiftPerFret: 1.921,
  shiftFast: 2.1,
  shiftSlow: 0.3,
  stringSkip: 0.2,
  repeatPitchMove: 0.14,
  ringCut: 1.176,
  // Not fitted (no video in the benchmark): scaled with the per-fret shift cost so a filmed hand
  // position keeps its influence.
  handMiss: 6,
  stringChangeStep: 0.1,
  stringChangeThird: 0.1,
  stringChangeFourth: 0.3,
  stringChangeFast: 0.6,
  chordSustain: 0.04,
  // Chosen on the album recordings: removes most fast jumps across the neck without losing note
  // accuracy; lower values start dropping real notes (see the sweep in tests/tune.album.test.ts).
  dropNote: 16,
};

/** Bass weights (hand-set; the benchmark has no bass tabs). */
export const BASS_WEIGHTS: FingeringWeights = {
  stretch1: 1.5,
  stretch2: 4,
  stretchBeyond: Infinity,
  barre: 0.5,
  flatBarre: 0.3,
  fretHeight: 0.06,
  highFret: 0.1,
  highFretFrom: 15,
  openSingle: 0.3,
  openChordHigh: 0.2,
  openChordLow: 0.2,
  mutedInner: 0.4,
  // Very slight preference for keeping bass lines off the thinnest string's high frets.
  thinStringHigh: 0.2,
  shiftBase: 1,
  shiftPerFret: 0.35,
  shiftFast: 1.5,
  shiftSlow: 0.6,
  stringSkip: 0.1,
  repeatPitchMove: 0.8,
  ringCut: 0,
  handMiss: 1.5,
  stringChangeStep: 0,
  stringChangeThird: 0,
  stringChangeFourth: 0,
  stringChangeFast: 0,
  chordSustain: -Infinity,
  dropNote: Infinity,
};

export function weightsFor(instrument: InstrumentKind, overrides?: Partial<FingeringWeights>): FingeringWeights {
  return { ...(instrument === 'bass' ? BASS_WEIGHTS : GUITAR_WEIGHTS), ...overrides };
}

export interface FingeringResult<N extends NoteIn = NoteIn> {
  notes: FingeredNote<N>[];
  /** Notes that could not be placed (more simultaneous notes than strings). */
  dropped: N[];
}

export interface Candidate {
  /**
   * Indices of the event's notes this shape plays (undefined: all of them); the others are
   * dropped. `strings` and `frets` follow this order.
   */
  keep?: number[];
  /** Per played note (event order): string and fret. */
  strings: number[];
  frets: number[];
  cost: number;
  minFret: number; // among fretted notes, Infinity if all open
  maxFret: number;
}

interface Event<N extends NoteIn> {
  start: number;
  notes: Array<{ note: N; pitch: number; folded: boolean }>;
  candidates: Candidate[];
}

const MAX_CANDIDATES = 40;
/** Shapes kept per number of dropped notes (see FingeringWeights.dropNote). */
const MAX_DROP_CANDIDATES = 8;

function handWindow(pos: number): number {
  // Frets get narrower up the neck: four fingers comfortably cover 4 frets in open/low
  // positions, 5 from around the 5th fret and 6 from the 12th.
  return pos >= 12 ? 5 : pos >= 5 ? 4 : 3;
}

function staticCost(frets: number[], strings: number[], w: FingeringWeights, nStrings: number): number {
  const fretted = frets.filter((f) => f > 0);
  const single = frets.length === 1;
  let cost = 0;
  if (fretted.length > 0) {
    const minF = Math.min(...fretted);
    const maxF = Math.max(...fretted);
    const span = maxF - minF;
    const comfortable = handWindow(minF);
    if (span > comfortable + 2) {
      if (w.stretchBeyond === Infinity) return Infinity;
      cost += w.stretch2 + w.stretchBeyond * (span - comfortable - 2);
    } else if (span === comfortable + 1) cost += w.stretch1;
    else if (span === comfortable + 2) cost += w.stretch2;

    const atMin = fretted.filter((f) => f === minF).length;
    const above = fretted.length - atMin;
    const barre = atMin > 1 && above > 0;
    const fingers = (atMin > 1 ? 1 : atMin) + above;
    if (fingers > 4) return Infinity;
    if (barre) cost += w.barre;
    if (atMin > 1 && above === 0 && fretted.length > 2) cost += w.flatBarre; // flat barre across strings

    cost += w.fretHeight * minF;
    if (maxF > w.highFretFrom) cost += w.highFret * (maxF - w.highFretFrom);
  }
  const open = frets.length - fretted.length;
  if (open > 0) {
    if (single) cost -= w.openSingle;
    else {
      const high = fretted.length > 0 && Math.min(...fretted) >= 5;
      cost += open * (high ? w.openChordHigh : -w.openChordLow);
    }
  }
  if (frets.length >= 3) {
    // Unplayed strings between played ones are hard to mute when strumming.
    const used = new Set(strings);
    const lo = Math.min(...strings);
    const hi = Math.max(...strings);
    for (let s = lo + 1; s < hi; s++) if (!used.has(s)) cost += w.mutedInner;
  }
  if (single && strings[0] === nStrings - 1 && frets[0] > 9) cost += w.thinStringHigh;
  return cost;
}

function enumerate(pitches: number[], opts: FingeringOptions, w: FingeringWeights, monotonic: boolean): Candidate[] {
  const open = opts.tuning.strings.map((s) => s + opts.capo);
  const maxFret = opts.frets - opts.capo;
  const out: Candidate[] = [];
  const strings: number[] = [];
  const frets: number[] = [];
  const used = new Set<number>();
  const rec = (i: number) => {
    if (out.length > 5000) return;
    if (i === pitches.length) {
      const cost = staticCost(frets, strings, w, open.length);
      if (cost === Infinity) return;
      const fretted = frets.filter((f) => f > 0);
      out.push({
        strings: [...strings],
        frets: [...frets],
        cost,
        minFret: fretted.length ? Math.min(...fretted) : Infinity,
        maxFret: fretted.length ? Math.max(...fretted) : -Infinity,
      });
      return;
    }
    const from = monotonic && i > 0 ? strings[i - 1] + 1 : 0;
    for (let s = from; s < open.length; s++) {
      if (used.has(s)) continue;
      const f = pitches[i] - open[s];
      if (f < 0 || f > maxFret) continue;
      used.add(s);
      strings.push(s);
      frets.push(f);
      rec(i + 1);
      strings.pop();
      frets.pop();
      used.delete(s);
    }
  };
  rec(0);
  return out;
}

/**
 * Notes below the lowest string are moved up by octaves (usually a tuning mismatch or an
 * octave error of the detector). Notes more than a whole tone above the top of the neck are
 * almost always overtones and are dropped; slightly-too-high notes are moved down.
 */
function foldIntoRange(pitch: number, low: number, high: number): number {
  if (pitch > high + 2) return NaN;
  let p = pitch;
  while (p < low) p += 12;
  while (p > high) p -= 12;
  return p < low ? NaN : p;
}

/**
 * Every playable shape for simultaneous `pitches` (sorted low to high): shapes whose strings
 * ascend with pitch, or any shape when there is none of those.
 */
function playableShapes(pitches: number[], opts: FingeringOptions, w: FingeringWeights): Candidate[] {
  const ascending = enumerate(pitches, opts, w, true);
  return ascending.length > 0 ? ascending : enumerate(pitches, opts, w, false);
}

/** Whether note `j + 1` joins the chord sorted[i..j] (see FingeringWeights.chordSustain). */
function joinsChord(sorted: NoteIn[], i: number, j: number, sustain: number): boolean {
  if (sustain === -Infinity) return true;
  const next = sorted[j + 1];
  for (let k = i; k <= j; k++) {
    if (next.start - sorted[k].start > 0.005 && sorted[k].end < next.start + sustain) return false;
  }
  return true;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Shapes that leave out the weakest note (or two, in chords of three or more), each costing
 * `dropNote` × the left-out notes' confidence. A single note can be left out entirely.
 */
function dropCandidates(
  members: Array<{ note: NoteIn; pitch: number }>,
  confidence: (n: NoteIn) => number,
  opts: FingeringOptions,
  w: FingeringWeights,
  hint: HandHint | null,
): Candidate[] {
  const out: Candidate[] = [];
  const weakestFirst = members.map((_, k) => k).sort((a, b) => confidence(members[a].note) - confidence(members[b].note));
  const maxDrop = members.length >= 3 ? 2 : 1;
  for (let d = 1; d <= maxDrop; d++) {
    const omitted = weakestFirst.slice(0, d);
    const keep = members.map((_, k) => k).filter((k) => !omitted.includes(k));
    const penalty = w.dropNote * omitted.reduce((sum, k) => sum + confidence(members[k].note), 0);
    if (keep.length === 0) {
      out.push({ keep, strings: [], frets: [], cost: penalty, minFret: Infinity, maxFret: -Infinity });
      continue;
    }
    const shapes = playableShapes(
      keep.map((k) => members[k].pitch),
      opts,
      w,
    );
    for (const c of shapes) {
      c.keep = keep;
      c.cost += penalty;
      if (hint) c.cost += w.handMiss * hint.confidence * c.frets.reduce((sum, f) => sum + fretMiss(f, hint), 0);
    }
    shapes.sort((a, b) => a.cost - b.cost);
    out.push(...shapes.slice(0, MAX_DROP_CANDIDATES));
  }
  return out;
}

function buildEvents<N extends NoteIn>(notes: N[], opts: FingeringOptions, w: FingeringWeights, dropped: N[]): Event<N>[] {
  const low = opts.tuning.strings[0] + opts.capo;
  const high = opts.tuning.strings[opts.tuning.strings.length - 1] + opts.frets;
  const window = opts.instrument === 'bass' ? 0.03 : 0.045;
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  // Fast runs are short but not quiet: spurious detections show up as low amplitude.
  const typical = median(notes.map((n) => n.amplitude)) || 1;
  const confidence = (n: NoteIn) => n.amplitude / typical;
  const events: Event<N>[] = [];
  let i = 0;
  while (i < sorted.length) {
    const t0 = sorted[i].start;
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].start - t0 <= window && joinsChord(sorted, i, j, w.chordSustain)) j++;
    const group = sorted.slice(i, j + 1);
    i = j + 1;

    // Fold out-of-range notes by octaves, then merge duplicates (keep the strongest).
    const byPitch = new Map<number, { note: N; pitch: number; folded: boolean }>();
    for (const note of group) {
      const pitch = foldIntoRange(note.pitch, low, high);
      if (!(pitch >= low && pitch <= high)) {
        dropped.push(note);
        continue;
      }
      const existing = byPitch.get(pitch);
      if (!existing || existing.note.amplitude < note.amplitude) {
        if (existing) dropped.push(existing.note);
        byPitch.set(pitch, { note, pitch, folded: pitch !== note.pitch });
      } else dropped.push(note);
    }
    let members = [...byPitch.values()].sort((a, b) => a.pitch - b.pitch);

    // Find playable shapes; if none, drop the weakest note and retry.
    let candidates: Candidate[] = [];
    while (members.length > 0) {
      if (members.length <= opts.tuning.strings.length) {
        candidates = playableShapes(
          members.map((m) => m.pitch),
          opts,
          w,
        );
        if (candidates.length > 0) break;
      }
      let weakest = 0;
      members.forEach((m, k) => {
        if (m.note.amplitude < members[weakest].note.amplitude) weakest = k;
      });
      dropped.push(members[weakest].note);
      members = members.filter((_, k) => k !== weakest);
    }
    if (members.length === 0) continue;
    const hint = opts.hand?.(t0) ?? null;
    if (hint) {
      for (const c of candidates) c.cost += w.handMiss * hint.confidence * c.frets.reduce((s, f) => s + fretMiss(f, hint), 0);
    }
    candidates.sort((a, b) => a.cost - b.cost);
    let kept = candidates.slice(0, MAX_CANDIDATES);
    if (Number.isFinite(w.dropNote)) kept = kept.concat(dropCandidates(members, confidence, opts, w, hint));
    events.push({ start: t0, notes: members, candidates: kept });
  }
  return events;
}

/**
 * The hand is modelled as the range of index-finger frets consistent with everything played
 * since the last shift ([lo, hi]; empty/NaN before the first fretted note). A shape can be
 * played with the index finger anywhere in [maxFret - reach, minFret]; if that overlaps the
 * current range the hand does not move, otherwise it shifts by the gap between the ranges.
 */
export interface Hand {
  lo: number;
  hi: number;
}

const FREE_HAND: Hand = { lo: NaN, hi: NaN };

function shapeRange(c: Candidate): Hand {
  if (c.maxFret - c.minFret > handWindow(c.minFret)) return { lo: c.minFret, hi: c.minFret }; // stretch
  const reach = handWindow(Math.max(1, c.maxFret - 5));
  return { lo: Math.max(1, c.maxFret - reach), hi: c.minFret };
}

export function moveHand(hand: Hand, c: Candidate): { hand: Hand; shift: number } {
  if (c.minFret === Infinity) return { hand, shift: 0 };
  const r = shapeRange(c);
  if (!Number.isFinite(hand.lo)) return { hand: r, shift: 0 };
  const lo = Math.max(hand.lo, r.lo);
  const hi = Math.min(hand.hi, r.hi);
  if (lo <= hi) return { hand: { lo, hi }, shift: 0 };
  return { hand: r, shift: Math.max(r.lo - hand.hi, hand.lo - r.hi) };
}

function played<N extends NoteIn>(ev: Event<N>, c: Candidate): Event<N>['notes'] {
  return c.keep ? c.keep.map((k) => ev.notes[k]) : ev.notes;
}

function transitionCost<N extends NoteIn>(prev: Event<N>, pc: Candidate, cur: Event<N>, cc: Candidate, hand: Hand, w: FingeringWeights): { cost: number; hand: Hand } {
  const dt = Math.max(0, cur.start - prev.start);
  const moved = moveHand(hand, cc);
  let cost = 0;
  if (moved.shift > 0) {
    const speed = dt < 0.12 ? w.shiftFast : dt > 0.6 ? w.shiftSlow : 1;
    cost += (w.shiftBase + w.shiftPerFret * moved.shift) * speed;
  }
  const prevNotes = played(prev, pc);
  const curNotes = played(cur, cc);
  if (prevNotes.length === 1 && curNotes.length === 1) {
    const jump = Math.abs(cc.strings[0] - pc.strings[0]);
    cost += w.stringSkip * Math.max(0, jump - 1);
    if (prevNotes[0].pitch === curNotes[0].pitch && (pc.strings[0] !== cc.strings[0] || pc.frets[0] !== cc.frets[0])) cost += w.repeatPitchMove;
    if (jump > 0) {
      const interval = Math.abs(curNotes[0].pitch - prevNotes[0].pitch);
      if (interval >= 1 && interval <= 2) cost += w.stringChangeStep;
      else if (interval >= 3 && interval <= 4) cost += w.stringChangeThird;
      else if (interval >= 5 && interval <= 7) cost += w.stringChangeFourth;
      if (interval >= 1 && interval <= 4 && dt < 0.1) cost += w.stringChangeFast;
    }
  }
  if (w.ringCut) {
    // Re-using a string that is still ringing cuts the previous note short.
    const curStrings = new Set(cc.strings);
    prevNotes.forEach((m, k) => {
      if (m.note.end > cur.start + 0.05 && curStrings.has(pc.strings[k])) cost += w.ringCut;
    });
  }
  return { cost, hand: moved.hand };
}

export function assignFingerings<N extends NoteIn>(notes: N[], opts: FingeringOptions): FingeringResult<N> {
  const dropped: N[] = [];
  const w = weightsFor(opts.instrument, opts.weights);
  const events = buildEvents(notes, opts, w, dropped);
  if (events.length === 0) return { notes: [], dropped };

  // Viterbi over candidate shapes, carrying the hand position of each best path.
  let cost = events[0].candidates.map((c) => c.cost);
  let hand = events[0].candidates.map((c) => moveHand(FREE_HAND, c).hand);
  const back: Int32Array[] = [new Int32Array(events[0].candidates.length).fill(-1)];
  for (let t = 1; t < events.length; t++) {
    const prev = events[t - 1];
    const cur = events[t];
    const nextCost = new Array<number>(cur.candidates.length).fill(Infinity);
    const nextHand = new Array<Hand>(cur.candidates.length).fill(FREE_HAND);
    const ptr = new Int32Array(cur.candidates.length).fill(0);
    cur.candidates.forEach((cc, j) => {
      prev.candidates.forEach((pc, i) => {
        if (cost[i] === Infinity) return;
        const tr = transitionCost(prev, pc, cur, cc, hand[i], w);
        const total = cost[i] + tr.cost + cc.cost;
        if (total < nextCost[j]) {
          nextCost[j] = total;
          nextHand[j] = tr.hand;
          ptr[j] = i;
        }
      });
    });
    cost = nextCost;
    hand = nextHand;
    back.push(ptr);
  }

  let best = 0;
  cost.forEach((c, i) => {
    if (c < cost[best]) best = i;
  });
  const chosen: number[] = new Array(events.length);
  for (let t = events.length - 1; t >= 0; t--) {
    chosen[t] = best;
    best = back[t][best];
  }

  const out: FingeredNote<N>[] = [];
  events.forEach((ev, t) => {
    const c = ev.candidates[chosen[t]];
    played(ev, c).forEach((m, k) => out.push({ note: m.note, pitch: m.pitch, string: c.strings[k], fret: c.frets[k], folded: m.folded }));
    if (c.keep) ev.notes.forEach((m, k) => c.keep!.includes(k) || dropped.push(m.note));
  });
  return { notes: out, dropped };
}
