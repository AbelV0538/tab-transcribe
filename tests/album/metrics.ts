/**
 * Benchmark metrics: note matching, fingering agreement and playability statistics.
 *
 * The playability statistics use their own fixed hand model (a copy of the fingering
 * optimiser's model as it was when the benchmark was written), so the yardstick does not move
 * when the optimiser's weights are tuned.
 */

export interface Placed {
  pitch: number;
  string: number;
  fret: number;
  start: number;
  end: number;
}

/** Comfortable fret span of the fretting hand with the index finger at `pos`. */
function comfortable(pos: number): number {
  return pos >= 12 ? 5 : pos >= 5 ? 4 : 3;
}

interface HandRange {
  lo: number;
  hi: number;
}

function shapeRange(minF: number, maxF: number): HandRange {
  if (maxF - minF > comfortable(minF)) return { lo: minF, hi: minF };
  const reach = comfortable(Math.max(1, maxF - 5));
  return { lo: Math.max(1, maxF - reach), hi: minF };
}

/** Group notes into simultaneous events (same window as the guitar fingering optimiser). */
export function groupEvents<T extends { start: number }>(notes: T[], window = 0.045): T[][] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const out: T[][] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].start - sorted[i].start <= window) j++;
    out.push(sorted.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

export interface PlayabilityStats {
  notes: number;
  events: number;
  /** Seconds from the first to the last onset. */
  seconds: number;
  /** Hand shifts per minute. */
  shiftsPerMin: number;
  /** Mean shift distance in frets. */
  meanShift: number;
  /** Shifts of 5+ frets with less than 150 ms to make them, per minute. */
  fastJumpsPerMin: number;
  /** Shapes beyond a hand's reach: span above comfortable + 2 frets, or more than 4 fingers. */
  overStretched: number;
  /** Events with two notes starting together (within 10 ms) on the same string. */
  stringCollisions: number;
  meanFret: number;
  openRate: number;
}

export function playability(notes: Placed[], window = 0.045): PlayabilityStats {
  const events = groupEvents(notes, window);
  let hand: HandRange | null = null;
  let lastFrettedStart = -Infinity;
  let shifts = 0;
  let shiftSum = 0;
  let fastJumps = 0;
  let overStretched = 0;
  let collisions = 0;
  for (const ev of events) {
    // Notes starting together on one string (a grace note and its target are not a collision).
    if (ev.some((a, i) => ev.some((b, j) => j > i && a.string === b.string && Math.abs(a.start - b.start) < 0.01))) collisions++;
    const fretted = ev.map((n) => n.fret).filter((f) => f > 0);
    if (fretted.length === 0) continue;
    const minF = Math.min(...fretted);
    const maxF = Math.max(...fretted);
    const atMin = fretted.filter((f) => f === minF).length;
    const fingers = (atMin > 1 ? 1 : atMin) + (fretted.length - atMin);
    if (maxF - minF > comfortable(minF) + 2 || fingers > 4) overStretched++;
    const r = shapeRange(minF, maxF);
    const t = ev[0].start;
    if (hand) {
      const lo = Math.max(hand.lo, r.lo);
      const hi = Math.min(hand.hi, r.hi);
      if (lo <= hi) hand = { lo, hi };
      else {
        const shift = Math.max(r.lo - hand.hi, hand.lo - r.hi);
        shifts++;
        shiftSum += shift;
        if (shift >= 5 && t - lastFrettedStart < 0.15) fastJumps++;
        hand = r;
      }
    } else hand = r;
    lastFrettedStart = t;
  }
  const allFretted = notes.filter((n) => n.fret > 0);
  const seconds = notes.length ? Math.max(1, Math.max(...notes.map((n) => n.start)) - Math.min(...notes.map((n) => n.start))) : 1;
  return {
    notes: notes.length,
    events: events.length,
    seconds,
    shiftsPerMin: (60 * shifts) / seconds,
    meanShift: shifts ? shiftSum / shifts : 0,
    fastJumpsPerMin: (60 * fastJumps) / seconds,
    overStretched,
    stringCollisions: collisions,
    meanFret: allFretted.length ? allFretted.reduce((s, n) => s + n.fret, 0) / allFretted.length : 0,
    openRate: notes.length ? (notes.length - allFretted.length) / notes.length : 0,
  };
}

/** Sum playability counts over several tracks (rates weighted by duration). */
export function sumPlayability(list: PlayabilityStats[]): PlayabilityStats {
  const seconds = list.reduce((s, p) => s + p.seconds, 0) || 1;
  const notes = list.reduce((s, p) => s + p.notes, 0) || 1;
  const shifts = list.reduce((s, p) => s + (p.shiftsPerMin * p.seconds) / 60, 0);
  return {
    notes: list.reduce((s, p) => s + p.notes, 0),
    events: list.reduce((s, p) => s + p.events, 0),
    seconds,
    shiftsPerMin: (60 * shifts) / seconds,
    meanShift: shifts ? list.reduce((s, p) => s + p.meanShift * ((p.shiftsPerMin * p.seconds) / 60), 0) / shifts : 0,
    fastJumpsPerMin: list.reduce((s, p) => s + p.fastJumpsPerMin * p.seconds, 0) / seconds,
    overStretched: list.reduce((s, p) => s + p.overStretched, 0),
    stringCollisions: list.reduce((s, p) => s + p.stringCollisions, 0),
    meanFret: list.reduce((s, p) => s + p.meanFret * p.notes, 0) / notes,
    openRate: list.reduce((s, p) => s + p.openRate * p.notes, 0) / notes,
  };
}

export interface MatchResult<R, G> {
  /** Pairs of matched reference and detected notes. */
  pairs: Array<[R, G]>;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Greedy one-to-one matching of detected notes to reference notes: same pitch (or the same
 * pitch class when `octaveFree`) and onsets within `tol` seconds, closest onsets first.
 */
export function matchNotes<R extends { pitch: number; start: number }, G extends { pitch: number; start: number }>(
  ref: R[],
  got: G[],
  tol = 0.05,
  octaveFree = false,
): MatchResult<R, G> {
  const key = (p: number) => (octaveFree ? ((p % 12) + 12) % 12 : p);
  const byKey = new Map<number, number[]>();
  got.forEach((g, i) => {
    const k = key(g.pitch);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(i);
  });
  for (const list of byKey.values()) list.sort((a, b) => got[a].start - got[b].start);
  const cands: Array<[number, number, number]> = [];
  ref.forEach((r, ri) => {
    const list = byKey.get(key(r.pitch));
    if (!list) return;
    // Binary search for the first candidate at or after r.start - tol.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (got[list[mid]].start < r.start - tol) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < list.length && got[list[k]].start <= r.start + tol; k++) cands.push([Math.abs(got[list[k]].start - r.start), ri, list[k]]);
  });
  cands.sort((a, b) => a[0] - b[0]);
  const usedR = new Set<number>();
  const usedG = new Set<number>();
  const pairs: Array<[R, G]> = [];
  for (const [, ri, gi] of cands) {
    if (usedR.has(ri) || usedG.has(gi)) continue;
    usedR.add(ri);
    usedG.add(gi);
    pairs.push([ref[ri], got[gi]]);
  }
  const precision = got.length ? pairs.length / got.length : 0;
  const recall = ref.length ? pairs.length / ref.length : 0;
  return { pairs, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

export const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
export const fix = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
