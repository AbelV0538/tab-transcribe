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
}

export interface FingeringResult<N extends NoteIn = NoteIn> {
  notes: FingeredNote<N>[];
  /** Notes that could not be placed (more simultaneous notes than strings). */
  dropped: N[];
}

export interface Candidate {
  /** Per note in the event (same order): string and fret. */
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

function handWindow(pos: number): number {
  // Frets get narrower up the neck: four fingers comfortably cover 4 frets in open/low
  // positions, 5 from around the 5th fret and 6 from the 12th.
  return pos >= 12 ? 5 : pos >= 5 ? 4 : 3;
}

function staticCost(frets: number[], strings: number[], instrument: InstrumentKind, nStrings: number): number {
  const fretted = frets.filter((f) => f > 0);
  const single = frets.length === 1;
  let cost = 0;
  if (fretted.length > 0) {
    const minF = Math.min(...fretted);
    const maxF = Math.max(...fretted);
    const span = maxF - minF;
    const comfortable = handWindow(minF);
    if (span > comfortable + 2) return Infinity;
    if (span === comfortable + 1) cost += 1.5;
    else if (span === comfortable + 2) cost += 4;

    const atMin = fretted.filter((f) => f === minF).length;
    const above = fretted.length - atMin;
    const barre = atMin > 1 && above > 0;
    const fingers = (atMin > 1 ? 1 : atMin) + above;
    if (fingers > 4) return Infinity;
    if (barre) cost += 0.5;
    if (atMin > 1 && above === 0 && fretted.length > 2) cost += 0.3; // flat barre across strings

    cost += (instrument === 'bass' ? 0.06 : 0.04) * minF;
    if (maxF > 15) cost += 0.1 * (maxF - 15);
  }
  const open = frets.length - fretted.length;
  if (open > 0) {
    if (single) cost -= instrument === 'bass' ? 0.3 : 0.35;
    else {
      const high = fretted.length > 0 && Math.min(...fretted) >= 5;
      cost += open * (high ? 0.2 : -0.2);
    }
  }
  if (frets.length >= 3) {
    // Unplayed strings between played ones are hard to mute when strumming.
    const used = new Set(strings);
    const lo = Math.min(...strings);
    const hi = Math.max(...strings);
    for (let s = lo + 1; s < hi; s++) if (!used.has(s)) cost += 0.4;
  }
  // Very slight preference for keeping bass lines off the thinnest strings' high frets.
  if (instrument === 'bass' && single && strings[0] === nStrings - 1 && frets[0] > 9) cost += 0.2;
  return cost;
}

function enumerate(pitches: number[], opts: FingeringOptions, monotonic: boolean): Candidate[] {
  const open = opts.tuning.strings.map((s) => s + opts.capo);
  const maxFret = opts.frets - opts.capo;
  const out: Candidate[] = [];
  const strings: number[] = [];
  const frets: number[] = [];
  const used = new Set<number>();
  const rec = (i: number) => {
    if (out.length > 5000) return;
    if (i === pitches.length) {
      const cost = staticCost(frets, strings, opts.instrument, open.length);
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

function buildEvents<N extends NoteIn>(notes: N[], opts: FingeringOptions, dropped: N[]): Event<N>[] {
  const low = opts.tuning.strings[0] + opts.capo;
  const high = opts.tuning.strings[opts.tuning.strings.length - 1] + opts.frets;
  const window = opts.instrument === 'bass' ? 0.03 : 0.045;
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const events: Event<N>[] = [];
  let i = 0;
  while (i < sorted.length) {
    const t0 = sorted[i].start;
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].start - t0 <= window) j++;
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
        const pitches = members.map((m) => m.pitch);
        candidates = enumerate(pitches, opts, true);
        if (candidates.length === 0) candidates = enumerate(pitches, opts, false);
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
    candidates.sort((a, b) => a.cost - b.cost);
    events.push({ start: t0, notes: members, candidates: candidates.slice(0, MAX_CANDIDATES) });
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

function transitionCost<N extends NoteIn>(prev: Event<N>, pc: Candidate, cur: Event<N>, cc: Candidate, hand: Hand, instrument: InstrumentKind): { cost: number; hand: Hand } {
  const dt = Math.max(0, cur.start - prev.start);
  const moved = moveHand(hand, cc);
  let cost = 0;
  if (moved.shift > 0) {
    const speed = dt < 0.12 ? 1.5 : dt > 0.6 ? 0.6 : 1;
    cost += (1 + 0.35 * moved.shift) * speed;
  }
  if (prev.notes.length === 1 && cur.notes.length === 1) {
    const jump = Math.abs(cc.strings[0] - pc.strings[0]);
    cost += 0.1 * Math.max(0, jump - 1);
    if (prev.notes[0].pitch === cur.notes[0].pitch && (pc.strings[0] !== cc.strings[0] || pc.frets[0] !== cc.frets[0])) cost += 0.8;
  }
  if (instrument === 'guitar') {
    // Re-using a string that is still ringing cuts the previous note short.
    const curStrings = new Set(cc.strings);
    prev.notes.forEach((m, k) => {
      if (m.note.end > cur.start + 0.05 && curStrings.has(pc.strings[k])) cost += 0.3;
    });
  }
  return { cost, hand: moved.hand };
}

export function assignFingerings<N extends NoteIn>(notes: N[], opts: FingeringOptions): FingeringResult<N> {
  const dropped: N[] = [];
  const events = buildEvents(notes, opts, dropped);
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
        const tr = transitionCost(prev, pc, cur, cc, hand[i], opts.instrument);
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
    ev.notes.forEach((m, k) => out.push({ note: m.note, pitch: m.pitch, string: c.strings[k], fret: c.frets[k], folded: m.folded }));
  });
  return { notes: out, dropped };
}
