/**
 * Finds the fretting hand on the tracked fretboard.
 *
 * Each frame's board is resampled into a strip (fret position × position across the board)
 * through the tracked warp. The board itself does not change, so the per-cell median over the
 * whole video is the uncovered board; cells that differ strongly from it in a frame are covered.
 * The fretting hand is the covered stretch of the neck closest to the nut.
 */
import type { HandHint } from '../music/playthrough';
import { sample, type GrayImage } from './image';
import { neckPoint, type NeckModel } from './neck';
import { applyAffine, type Affine } from './track';

export interface StripSpec {
  /** Fret position (fractional) of each column. */
  frets: Float64Array;
  /** Lateral position (−1..1 across the board) of each row. */
  rows: number[];
}

/** Columns every 1/6 fret from just above the nut to `maxFret`. */
export function stripSpec(maxFret: number): StripSpec {
  const frets: number[] = [];
  for (let f = 0.25; f <= maxFret + 1e-9; f += 1 / 6) frets.push(f);
  return { frets: Float64Array.from(frets), rows: [-0.72, -0.48, -0.24, 0, 0.24, 0.48, 0.72] };
}

/**
 * Board strip of one frame, in calibration-frame brightness (gain/bias applied), row-major
 * [row][column]; NaN where the board is outside the frame. `img` should be lightly blurred.
 */
export function sampleStrip(img: GrayImage, scale: number, model: NeckModel, warp: Affine, gain: number, bias: number, spec: StripSpec): Float32Array {
  const cols = spec.frets.length;
  const out = new Float32Array(cols * spec.rows.length);
  spec.rows.forEach((t, r) => {
    for (let c = 0; c < cols; c++) {
      const [x, y] = applyAffine(warp, ...neckPoint(model, spec.frets[c], t));
      const v = sample(img, x / scale, y / scale);
      out[r * cols + c] = Number.isNaN(v) ? NaN : gain * v + bias;
    }
  });
  return out;
}

/** Centre of the shortest range of sorted `values` that holds `k` of them. */
function densest(values: number[], k: number): number {
  k = Math.min(k, values.length);
  let best = 0;
  for (let s = 1; s + k - 1 < values.length; s++) if (values[s + k - 1] - values[s] < values[best + k - 1] - values[best]) best = s;
  return values[best + (k >> 1)];
}

export interface HandObservation {
  time: number;
  /** Covered stretch of the neck (fractional fret positions), or null if no hand on the board. */
  from: number | null;
  to: number | null;
  /** True when the covered stretch runs into the edge of the visible board towards the nut. */
  cutOff: boolean;
  /** Lowest visible fret position in this frame. */
  visibleFrom: number;
  /** 0..1: tracking quality × how clearly the hand stands out. */
  confidence: number;
}

/**
 * Turn per-frame observations into fret windows. A covered stretch from..to becomes spaces
 * floor(from)..ceil(to)+1 (the pinky may not cover the board visibly). A stretch cut off at the
 * edge of the frame, or a well-tracked board with no hand on it, means the hand is below the
 * visible part of the neck: frets 0..(first visible fret + 1), with less confidence for the latter.
 */
export function toHints(observations: HandObservation[], trackOk: (i: number) => boolean): HandHint[] {
  const hints: HandHint[] = [];
  observations.forEach((o, i) => {
    if (o.from !== null && o.to !== null) {
      const hi = Math.ceil(o.to) + 1;
      hints.push({ time: o.time, lo: o.cutOff ? 0 : Math.max(0, Math.floor(o.from)), hi, confidence: o.confidence, seen: true });
    } else if (trackOk(i) && Number.isFinite(o.visibleFrom) && o.visibleFrom > 0.5) {
      hints.push({ time: o.time, lo: 0, hi: Math.ceil(o.visibleFrom) + 1, confidence: 0.4, seen: false });
    }
  });
  return hints;
}

interface FrameStrip {
  time: number;
  strip: Float32Array;
  trackScore: number;
}

export class HandLocator {
  private readonly frames: FrameStrip[] = [];

  /**
   * `reference` is the calibration frame's strip: the user is asked to pick a frame where the
   * neck is clear, so it shows the board even where the hand hardly ever leaves.
   */
  constructor(
    readonly spec: StripSpec,
    private readonly reference: Float32Array | null = null,
  ) {}

  add(time: number, strip: Float32Array | null, trackScore: number): void {
    this.frames.push({ time, strip: strip ?? new Float32Array(this.spec.frets.length * this.spec.rows.length).fill(NaN), trackScore: strip ? trackScore : 0 });
  }

  /**
   * The uncovered board, per cell. Not the median: a player can keep their hand over the same
   * frets for most of a video. Uncovered, a cell looks the same every time, while a moving hand
   * varies, so the board is the tightest cluster of values: the shortest brightness range that
   * holds 35% of the frames. Where even that is the hand (it hardly ever left), the fingerboard's
   * usual brightness along the rest of that row picks the board out of the rarer frames.
   */
  cleanBoard(): Float32Array {
    const cols = this.spec.frets.length;
    const n = cols * this.spec.rows.length;
    const board = new Float32Array(n).fill(NaN);
    const perCell: number[][] = [];
    for (let i = 0; i < n; i++) {
      const values: number[] = [];
      for (const f of this.frames) if (f.trackScore > 0.6 && !Number.isNaN(f.strip[i])) values.push(f.strip[i]);
      values.sort((a, b) => a - b);
      perCell.push(values);
      if (values.length >= 5) board[i] = densest(values, Math.max(3, Math.ceil(values.length * 0.35)));
    }
    for (let r = 0; r < this.spec.rows.length; r++) {
      const row = Array.from(board.subarray(r * cols, (r + 1) * cols)).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
      if (row.length < 5) continue;
      const level = row[row.length >> 1];
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (Number.isNaN(board[i]) || Math.abs(board[i] - level) <= 60) continue;
        const near = perCell[i].filter((v) => Math.abs(v - level) <= 45);
        const ref = this.reference?.[i] ?? NaN;
        if (near.length >= Math.max(3, 0.12 * perCell[i].length)) board[i] = densest(near, Math.max(2, Math.ceil(near.length * 0.5)));
        else if (Math.abs(ref - level) <= 45) board[i] = ref;
      }
    }
    return board;
  }

  observations(): HandObservation[] {
    const board = this.cleanBoard();
    const cols = this.spec.frets.length;
    const nRows = this.spec.rows.length;
    // Contrast of the board itself sets the threshold (dark boards with light hands work too).
    const valid = Array.from(board).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
    const spread = valid.length ? valid[Math.floor(valid.length * 0.9)] - valid[Math.floor(valid.length * 0.1)] : 60;
    const threshold = Math.max(30, 0.45 * spread);

    const boardAt = (r: number, c: number) => (r < 0 || r >= nRows || c < 0 || c >= cols ? NaN : board[r * cols + c]);

    return this.frames.map(({ time, strip, trackScore }) => {
      // Tracking errors shift the board locally (more at the far ends of the neck). For each
      // column, find the shift (±1/3 fret, ±1 row) that best matches the board within ±1 fret,
      // so misaligned inlays and fret wires aren't taken for fingers. A hand differs from the
      // board at every shift, so it survives.
      const shifts: Array<[number, number]> = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -2; dc <= 2; dc++) shifts.push([dr, dc]);
      const colCost = shifts.map(([dr, dc]) => {
        const cost = new Float64Array(cols);
        const count = new Float64Array(cols);
        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < nRows; r++) {
            const v = strip[r * cols + c];
            const b = boardAt(r + dr, c + dc);
            if (Number.isNaN(v) || Number.isNaN(b)) continue;
            cost[c] += Math.min(threshold, Math.abs(v - b));
            count[c]++;
          }
        }
        return { cost, count };
      });
      const cover = new Float32Array(cols);
      const seen = new Uint8Array(cols);
      for (let c = 0; c < cols; c++) {
        let best = 0;
        let bestCost = Infinity;
        shifts.forEach(([dr, dc], k) => {
          let sum = 0;
          let n = 0;
          for (let w = Math.max(0, c - 6); w <= Math.min(cols - 1, c + 6); w++) {
            sum += colCost[k].cost[w];
            n += colCost[k].count[w];
          }
          const cost = n ? sum / n + 0.5 * (Math.abs(dr) + Math.abs(dc)) : Infinity;
          if (cost < bestCost) {
            bestCost = cost;
            best = k;
          }
        });
        const [dr, dc] = shifts[best];
        let covered = 0;
        let visible = 0;
        for (let r = 0; r < nRows; r++) {
          const v = strip[r * cols + c];
          const b = boardAt(r + dr, c + dc);
          if (Number.isNaN(v) || Number.isNaN(b)) continue;
          visible++;
          if (Math.abs(v - b) > threshold) covered++;
        }
        seen[c] = visible >= nRows / 2 ? 1 : 0;
        cover[c] = visible ? covered / visible : 0;
      }
      const firstSeen = seen.indexOf(1);
      const empty: HandObservation = { time, from: null, to: null, cutOff: false, visibleFrom: firstSeen >= 0 ? this.spec.frets[firstSeen] : NaN, confidence: 0 };
      if (firstSeen < 0 || trackScore <= 0) return empty;
      // Smooth along the neck, then take the covered run closest to the nut.
      const sm = cover.map((_, c) => {
        let s = 0;
        let k = 0;
        for (let d = -1; d <= 1; d++) if (c + d >= 0 && c + d < cols && seen[c + d]) {
          s += cover[c + d];
          k++;
        }
        return k ? s / k : 0;
      });
      // Covered runs along the neck (gaps under ~3/4 fret bridged: between fingers, or a dark
      // inlay under a dark hand). The fretting hand is the biggest thing on the board.
      const runs: Array<[number, number, number]> = [];
      let rs = -1;
      let re = -1;
      for (let c = firstSeen; c <= cols; c++) {
        if (c < cols && seen[c] && sm[c] >= 0.34) {
          if (rs < 0) rs = c;
          re = c;
        } else if (rs >= 0 && (c === cols || c - re > 4)) {
          let mass = 0;
          for (let k = rs; k <= re; k++) mass += sm[k];
          if (re - rs >= 2) runs.push([rs, re, mass]);
          rs = -1;
        }
      }
      if (runs.length === 0) return empty;
      const [start, end] = runs.reduce((a, b) => (b[2] > a[2] ? b : a));
      let peak = 0;
      for (let c = start; c <= end; c++) peak = Math.max(peak, sm[c]);
      const cutOff = start - firstSeen <= 1;
      return {
        time,
        from: this.spec.frets[start],
        to: this.spec.frets[end],
        cutOff,
        visibleFrom: this.spec.frets[firstSeen],
        confidence: Math.max(0, Math.min(1, (trackScore - 0.45) / 0.4)) * Math.min(1, peak / 0.6),
      };
    });
  }
}
