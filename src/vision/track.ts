/**
 * Follows the fretboard through a video by aligning each frame to the calibration frame.
 *
 * The template is the calibrated board (plus a margin, for its edges) sampled from the
 * calibration frame. Each frame is aligned with a similarity warp (rotation, scale, shift) plus
 * brightness gain/offset: a coarse translation/rotation search at quarter resolution, then
 * Gauss-Newton refinement (Lucas-Kanade) down the image pyramid. Residuals get Tukey weights,
 * so the fretting hand, which covers part of the board, does not drag the fit. Every frame is
 * aligned to the same reference, so errors do not accumulate over time.
 *
 * Fretboards are self-similar: scaling by 2^(-1/12) about the nut maps each fret onto the next,
 * and inlays repeat every two frets, so an unconstrained warp can "slide" along the neck by a
 * fret or two with a matching change of scale. Scale therefore gets a prior that keeps it
 * close to the previous frame's (the camera distance changes slowly).
 */
import { pyramid, sample, type GrayImage } from './image';
import { fretDistance, halfWidthPx, neckPoint, type NeckModel } from './neck';

/** Maps calibration-frame coordinates to frame coordinates: x' = a x + b y + c, y' = d x + e y + f. */
export type Affine = [number, number, number, number, number, number];
export const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];

export function applyAffine(w: Affine, x: number, y: number): [number, number] {
  return [w[0] * x + w[1] * y + w[2], w[3] * x + w[4] * y + w[5]];
}

export interface TrackResult {
  warp: Affine;
  /** Brightness model mapping frame intensity to template intensity: T ≈ gain·I + bias. */
  gain: number;
  bias: number;
  /**
   * Zero-mean normalised cross-correlation between template and aligned frame (−1..1), over
   * the points that fit (so a hand covering part of the board doesn't lower it).
   */
  score: number;
  /** Fraction of template points inside the frame. */
  visible: number;
  /** Fraction of visible template points that fit (the rest are covered or changed). */
  inliers: number;
  ok: boolean;
}

const LEVELS = 3;
const MAX_POINTS = 2400;
const COARSE_POINTS = 320;

/**
 * Optimisation parameters: X = e^σ (cosθ·xc − sinθ·yc) + tx, Y = e^σ (sinθ·xc + cosθ·yc) + ty,
 * with (xc, yc) template coordinates relative to the template centroid.
 */
type Params = [number, number, number, number, number, number]; // θ σ tx ty gain bias

export class NeckTracker {
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly templates: Float32Array[];
  private readonly cx: number;
  private readonly cy: number;
  private readonly coarse: Int32Array;

  constructor(reference: GrayImage, readonly model: NeckModel, maxFret = 22) {
    const pyr = pyramid(reference, LEVELS);
    const xs: number[] = [];
    const ys: number[] = [];
    // Dense grid over the board and a margin around it, ~2.5 px apart.
    for (let f = 0.2; f <= maxFret + 0.5; ) {
      const d = fretDistance(f);
      const hw = halfWidthPx(model, d);
      const [x0, y0] = neckPoint(model, f, 0);
      const [x1, y1] = neckPoint(model, f + 0.05, 0);
      const pxPerFret = Math.hypot(x1 - x0, y1 - y0) / 0.05;
      const tStep = Math.min(0.5, 2.5 / Math.max(1, hw));
      for (let t = -1.35; t <= 1.35; t += tStep) {
        const [x, y] = neckPoint(model, f, t);
        if (x >= 2 && y >= 2 && x <= reference.width - 3 && y <= reference.height - 3) {
          xs.push(x);
          ys.push(y);
        }
      }
      f += Math.max(0.02, 2.5 / Math.max(1, pxPerFret));
    }
    if (xs.length < 50) throw new Error('The calibrated neck is not inside the frame');
    // Deterministic thinning to MAX_POINTS.
    const keep: number[] = [];
    const stride = Math.max(1, xs.length / MAX_POINTS);
    for (let i = 0; i < xs.length; i += stride) keep.push(Math.floor(i));
    this.xs = Float64Array.from(keep.map((i) => xs[i]));
    this.ys = Float64Array.from(keep.map((i) => ys[i]));
    this.cx = this.xs.reduce((s, v) => s + v, 0) / this.xs.length;
    this.cy = this.ys.reduce((s, v) => s + v, 0) / this.ys.length;
    this.templates = pyr.map((img, l) => {
      const s = 2 ** l;
      const t = new Float32Array(this.xs.length);
      for (let i = 0; i < t.length; i++) t[i] = sample(img, this.xs[i] / s, this.ys[i] / s);
      return t;
    });
    // Points with texture (strong template gradient) for the coarse search.
    const top = pyr[0];
    const grad = Array.from(this.xs, (x, i) => {
      const y = this.ys[i];
      return Math.abs(sample(top, x + 1, y) - sample(top, x - 1, y)) + Math.abs(sample(top, x, y + 1) - sample(top, x, y - 1));
    });
    const order = grad.map((g, i) => [g || 0, i]).sort((a, b) => b[0] - a[0]);
    this.coarse = Int32Array.from(order.slice(0, COARSE_POINTS).map((o) => o[1]));
  }

  /** Number of template points (for diagnostics). */
  get size(): number {
    return this.xs.length;
  }

  private toParams(w: Affine, gain = 1, bias = 0): Params {
    const { cx, cy } = this;
    const scale = Math.sqrt(Math.max(1e-6, w[0] * w[4] - w[1] * w[3]));
    return [Math.atan2(w[3], w[0]), Math.log(scale), w[0] * cx + w[1] * cy + w[2], w[3] * cx + w[4] * cy + w[5], gain, bias];
  }

  private toAffine(p: Params): Affine {
    const { cx, cy } = this;
    const s = Math.exp(p[1]);
    const a = s * Math.cos(p[0]);
    const d = s * Math.sin(p[0]);
    return [a, -d, p[2] - a * cx + d * cy, d, a, p[3] - d * cx - a * cy];
  }

  private map(p: Params, i: number): [number, number] {
    const xc = this.xs[i] - this.cx;
    const yc = this.ys[i] - this.cy;
    const s = Math.exp(p[1]);
    const c = Math.cos(p[0]);
    const sn = Math.sin(p[0]);
    return [s * (c * xc - sn * yc) + p[2], s * (sn * xc + c * yc) + p[3]];
  }

  /** ZNCC of the template against the frame under warp `p`, over point indices `idx`. */
  private ncc(img: GrayImage, level: number, p: Params, idx: ArrayLike<number>): { score: number; visible: number } {
    const s = 2 ** level;
    const t = this.templates[level];
    let n = 0;
    let st = 0;
    let si = 0;
    let stt = 0;
    let sii = 0;
    let sti = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const [X, Y] = this.map(p, i);
      const v = sample(img, X / s, Y / s);
      const tv = t[i];
      if (Number.isNaN(v) || Number.isNaN(tv)) continue;
      n++;
      st += tv;
      si += v;
      stt += tv * tv;
      sii += v * v;
      sti += tv * v;
    }
    if (n < 10) return { score: -1, visible: n / idx.length };
    const cov = sti - (st * si) / n;
    const den = Math.sqrt(Math.max(1e-9, (stt - (st * st) / n) * (sii - (si * si) / n)));
    return { score: cov / den, visible: n / idx.length };
  }

  /**
   * Exhaustive translation × rotation search at the coarsest level around `p`. Uses a truncated
   * absolute difference: covered or changed pixels cost the same at every offset, so a hand on
   * the board can't pull the match.
   */
  private coarseSearch(img: GrayImage, p: Params, radius: number, angles: number[]): Params {
    const level = LEVELS - 1;
    const step = 2 ** level;
    const t = this.templates[level];
    const TRUNC = 40;
    let best = p;
    let bestCost = Infinity;
    for (const deg of angles) {
      for (let dy = -radius; dy <= radius; dy += step) {
        for (let dx = -radius; dx <= radius; dx += step) {
          const q: Params = [p[0] + (deg * Math.PI) / 180, p[1], p[2] + dx, p[3] + dy, p[4], p[5]];
          let cost = 0;
          for (let k = 0; k < this.coarse.length; k++) {
            const i = this.coarse[k];
            const [X, Y] = this.map(q, i);
            const v = sample(img, X / step, Y / step);
            cost += Number.isNaN(v) || Number.isNaN(t[i]) ? TRUNC : Math.min(TRUNC, Math.abs(q[4] * v + q[5] - t[i]));
          }
          // Mild preference for small motion so ambiguous (repetitive) frets don't cause jumps.
          cost = cost / this.coarse.length + 0.05 * (Math.hypot(dx, dy) / step) + 0.2 * Math.abs(deg);
          if (cost < bestCost) {
            bestCost = cost;
            best = q;
          }
        }
      }
    }
    return best;
  }

  /**
   * Robust Gauss-Newton refinement at one pyramid level. `scalePrior` is the log-scale the
   * solution is pulled towards (the previous frame's); `stride` subsamples template points.
   */
  private refine(img: GrayImage, level: number, start: Params, iterations: number, scalePrior: number, stride: number): Params {
    const s = 2 ** level;
    const t = this.templates[level];
    const n = this.xs.length;
    const J = new Float64Array(n * 6);
    const r = new Float64Array(n);
    const valid = new Uint8Array(n);
    const p = [...start] as Params;
    for (let it = 0; it < iterations; it++) {
      let count = 0;
      for (let i = 0; i < n; i += stride) {
        valid[i] = 0;
        const tv = t[i];
        if (Number.isNaN(tv)) continue;
        const [X, Y] = this.map(p, i);
        const v = sample(img, X / s, Y / s);
        const gx = (sample(img, X / s + 1, Y / s) - sample(img, X / s - 1, Y / s)) / (2 * s);
        const gy = (sample(img, X / s, Y / s + 1) - sample(img, X / s, Y / s - 1)) / (2 * s);
        if (Number.isNaN(v) || Number.isNaN(gx) || Number.isNaN(gy)) continue;
        const g = p[4];
        const ox = X - p[2];
        const oy = Y - p[3];
        const o = i * 6;
        J[o] = g * (-gx * oy + gy * ox);
        J[o + 1] = g * (gx * ox + gy * oy);
        J[o + 2] = g * gx;
        J[o + 3] = g * gy;
        J[o + 4] = v;
        J[o + 5] = 1;
        r[i] = g * v + p[5] - tv;
        valid[i] = 1;
        count++;
      }
      if (count < 30) break;
      const abs: number[] = [];
      for (let i = 0; i < n; i += stride) if (valid[i]) abs.push(Math.abs(r[i]));
      abs.sort((a, b) => a - b);
      const c = robustCut(abs[abs.length >> 1]);
      const H = new Float64Array(36);
      const g = new Float64Array(6);
      for (let i = 0; i < n; i += stride) {
        if (!valid[i]) continue;
        const u = r[i] / c;
        if (Math.abs(u) >= 1) continue;
        const w = (1 - u * u) ** 2;
        const o = i * 6;
        for (let a = 0; a < 6; a++) {
          const ja = J[o + a] * w;
          g[a] += ja * r[i];
          for (let b = a; b < 6; b++) H[a * 6 + b] += ja * J[o + b];
        }
      }
      for (let a = 0; a < 6; a++) {
        for (let b = 0; b < a; b++) H[a * 6 + b] = H[b * 6 + a];
        H[a * 6 + a] = H[a * 6 + a] * 1.001 + 1e-6;
      }
      // Scale prior at a quarter of the data's own scale curvature: scale follows the pixels, but a
      // sudden jump (the signature of sliding along the self-similar frets) is resisted.
      const lambda = 0.25 * H[7];
      H[7] += lambda;
      g[1] += lambda * (p[1] - scalePrior);
      const delta = solveSym(H, g, 6);
      if (!delta) break;
      for (let a = 0; a < 6; a++) p[a] -= delta[a];
      if (!(Math.abs(p[1]) < 1.2) || !(p[4] > 0.2 && p[4] < 5)) return start;
      if (Math.abs(delta[2]) + Math.abs(delta[3]) < 0.02 * s && Math.abs(delta[0]) + Math.abs(delta[1]) < 1e-4) break;
    }
    return p;
  }

  /**
   * Align `frame` to the calibration frame. `initial` is the previous frame's warp (identity for
   * the calibration frame itself). `recover` widens the coarse search (use it after a frame
   * where tracking failed); otherwise the neck is assumed to have moved a little since `initial`.
   */
  track(frame: GrayImage, initial: Affine = IDENTITY, recover = false): TrackResult {
    const pyr = pyramid(frame, LEVELS);
    const init = this.toParams(initial);
    // Camera distance changes slowly: pull scale towards the previous frame's.
    const prior = init[1];
    let p = init;
    p = recover ? this.coarseSearch(pyr[LEVELS - 1], p, 96, [-12, -6, 0, 6, 12]) : this.coarseSearch(pyr[LEVELS - 1], p, 24, [-5, 0, 5]);
    for (let l = LEVELS - 1; l >= 0; l--) p = this.refine(pyr[l], l, p, l === 0 ? 10 : 15, prior, l === 2 ? 4 : l === 1 ? 2 : 1);
    const { score, visible, inliers } = this.quality(pyr[0], p);
    return { warp: this.toAffine(p), gain: p[4], bias: p[5], score, visible, inliers, ok: score > 0.6 && inliers > 0.4 && visible > 0.25 };
  }

  /** Correlation over the points that fit, with the same robust cut-off as the refinement. */
  private quality(img: GrayImage, p: Params): { score: number; visible: number; inliers: number } {
    const n = this.xs.length;
    const t = this.templates[0];
    const vals = new Float64Array(n).fill(NaN);
    const res: number[] = [];
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(t[i])) continue;
      const [X, Y] = this.map(p, i);
      const v = sample(img, X, Y);
      if (Number.isNaN(v)) continue;
      vals[i] = v;
      res.push(Math.abs(p[4] * v + p[5] - t[i]));
    }
    if (res.length < 30) return { score: -1, visible: res.length / n, inliers: 0 };
    const sorted = [...res].sort((a, b) => a - b);
    const cut = robustCut(sorted[sorted.length >> 1]);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (!Number.isNaN(vals[i]) && Math.abs(p[4] * vals[i] + p[5] - t[i]) < cut) idx.push(i);
    const { score } = this.ncc(img, 0, p, idx);
    return { score, visible: res.length / n, inliers: idx.length / res.length };
  }
}

/**
 * Tukey cut-off from the median absolute residual, capped so that a large occluder (a hand is
 * ~100+ grey levels off the board) can't inflate it enough to count as fitting.
 */
function robustCut(medianAbs: number): number {
  return 4.685 * Math.min(12, Math.max(4, 1.4826 * medianAbs));
}

/** Solve H x = g for a symmetric positive (semi-)definite n×n H by Cholesky; null if singular. */
function solveSym(H: Float64Array, g: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = H[i * n + j];
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (sum <= 1e-12) return null;
        L[i * n + i] = Math.sqrt(sum);
      } else L[i * n + j] = sum / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = g[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}
