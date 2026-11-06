/**
 * Align tab time to recording time.
 *
 * The tab's tempo map gives score seconds; the recording may start later, run at a slightly
 * different tempo, and contain material the tab doesn't (intros, extended outros, inserted
 * sections). We first fit a global tempo scale and offset by voting: every detected note and tab
 * note of the same pitch votes for the offset that would line them up. Then each segment of a few
 * bars picks its own offset among its strongest vote peaks, with a dynamic programme that
 * penalises jumps between neighbouring segments.
 */
import { matchNotes } from './metrics';

interface Timed {
  pitch: number;
  start: number;
}

export interface AlignSegment {
  /** Tab-time range [from, to). */
  from: number;
  to: number;
  /** Recording time = offset + scale × tab time. */
  offset: number;
  votes: number;
  notes: number;
}

export interface Alignment {
  scale: number;
  globalOffset: number;
  segments: AlignSegment[];
  /** Recording time of a tab time. */
  map(t: number): number;
  /** Share of tab notes matched by a detected note of the same pitch within 50 ms after alignment. */
  matchRate: number;
}

const BIN = 0.02;
const RANGE: [number, number] = [-20, 60];

function byPitch(notes: Timed[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const n of notes) {
    if (!m.has(n.pitch)) m.set(n.pitch, []);
    m.get(n.pitch)!.push(n.start);
  }
  for (const v of m.values()) v.sort((a, b) => a - b);
  return m;
}

/** Offset histogram (bins of BIN seconds over RANGE), smoothed over ±1 bin. */
function vote(det: Map<number, number[]>, tab: Timed[], scale: number, range = RANGE): Float32Array {
  const nBins = Math.ceil((range[1] - range[0]) / BIN);
  const h = new Float32Array(nBins);
  for (const g of tab) {
    const times = det.get(g.pitch);
    if (!times) continue;
    const t = scale * g.start;
    // Detected onsets d with d - t inside the range.
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t + range[0]) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < times.length && times[k] < t + range[1]; k++) {
      const b = Math.floor((times[k] - t - range[0]) / BIN);
      if (b >= 0 && b < nBins) h[b]++;
    }
  }
  const s = new Float32Array(nBins);
  for (let i = 0; i < nBins; i++) s[i] = h[i] + (i > 0 ? h[i - 1] : 0) + (i + 1 < nBins ? h[i + 1] : 0);
  return s;
}

function peaks(h: Float32Array, k: number, range = RANGE): Array<{ offset: number; votes: number }> {
  const out: Array<{ offset: number; votes: number; i: number }> = [];
  for (let i = 0; i < h.length; i++) {
    if (h[i] <= 0 || (i > 0 && h[i - 1] > h[i]) || (i + 1 < h.length && h[i + 1] > h[i])) continue;
    out.push({ offset: range[0] + (i + 0.5) * BIN, votes: h[i], i });
  }
  out.sort((a, b) => b.votes - a.votes);
  const picked: typeof out = [];
  for (const p of out) {
    if (picked.every((q) => Math.abs(q.i - p.i) > 10)) picked.push(p);
    if (picked.length >= k) break;
  }
  return picked;
}

/**
 * @param det detected notes (recording time)
 * @param tab tab notes (tab time), sounding pitches
 * @param barTimes tab-time start of each bar (segment boundaries)
 */
export function align(det: Timed[], tab: Timed[], barTimes: number[], manualOffset?: number): Alignment {
  const detBy = byPitch(det);
  let scale = 1;
  let globalOffset = 0;
  let best = -1;
  for (let s = 0.96; s <= 1.04 + 1e-9; s += 0.002) {
    const h = vote(detBy, tab, s);
    const p = peaks(h, 1)[0];
    if (p && p.votes > best) {
      best = p.votes;
      scale = s;
      globalOffset = p.offset;
    }
  }
  if (manualOffset !== undefined) {
    scale = 1;
    globalOffset = manualOffset;
  }

  // Segments of whole bars, about 6 s long.
  const bounds: number[] = [barTimes[0]];
  for (let i = 1; i < barTimes.length; i++) if (barTimes[i] - bounds[bounds.length - 1] >= 6 || i === barTimes.length - 1) bounds.push(barTimes[i]);
  const segs: Array<{ from: number; to: number; notes: Timed[]; cands: Array<{ offset: number; votes: number }> }> = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const notes = tab.filter((n) => n.start >= bounds[i] && n.start < bounds[i + 1]);
    const cands = notes.length >= 4 && manualOffset === undefined ? peaks(vote(detBy, notes, scale), 6) : [];
    cands.push({ offset: globalOffset, votes: 0 });
    segs.push({ from: bounds[i], to: bounds[i + 1], notes, cands });
  }

  // Dynamic programme: maximise votes minus jump penalties (backward jumps cost more).
  const jump = (a: number, b: number) => (b >= a ? 1 : 3) * Math.abs(b - a);
  let score = segs[0]?.cands.map((c) => c.votes - 0.05 * Math.abs(c.offset - globalOffset)) ?? [];
  const back: number[][] = [];
  for (let s = 1; s < segs.length; s++) {
    const prev = segs[s - 1].cands;
    const ptr: number[] = [];
    score = segs[s].cands.map((c) => {
      let bestK = 0;
      let bestV = -Infinity;
      prev.forEach((p, k) => {
        const v = score[k] - jump(p.offset, c.offset);
        if (v > bestV) {
          bestV = v;
          bestK = k;
        }
      });
      ptr.push(bestK);
      return bestV + c.votes;
    });
    back.push(ptr);
  }
  const chosen: number[] = new Array(segs.length).fill(0);
  if (segs.length) {
    chosen[segs.length - 1] = score.indexOf(Math.max(...score));
    for (let s = segs.length - 1; s > 0; s--) chosen[s - 1] = back[s - 1][chosen[s]];
  }
  const segments: AlignSegment[] = segs.map((s, i) => ({ from: s.from, to: s.to, offset: s.cands[chosen[i]].offset, votes: s.cands[chosen[i]].votes, notes: s.notes.length }));

  const map = (t: number) => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].from <= t) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo];
    return (seg ? seg.offset : globalOffset) + scale * t;
  };
  const mapped = tab.map((n) => ({ pitch: n.pitch, start: map(n.start) }));
  const matchRate = matchNotes(mapped, det, 0.05).recall;
  return { scale, globalOffset, segments, map, matchRate };
}
