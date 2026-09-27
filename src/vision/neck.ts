/**
 * Geometry of a fretboard seen in a video frame.
 *
 * The user marks two or three fret spaces (e.g. the inlays at frets 5 and 12) on one frame.
 * Frets follow the equal-tempered rule: fret k lies at D(k) = 1 - 2^(-k/12) of the scale length
 * from the nut. Image position along the neck is modelled as a 1-D projective function of D
 * (affine with two marks; the third mark adds perspective foreshortening), so every fret wire
 * can be drawn and every point on the neck converted back to a fret position.
 */
import type { InstrumentKind } from '../music/tunings';

export type Point = [number, number];

export interface FretMark {
  /** Image coordinates (pixels of the calibration frame). */
  x: number;
  y: number;
  /** Fret space marked (1 = between the nut and the first fret wire). */
  fret: number;
}

/** Fraction of the scale length from the nut to fret wire `k` (fractional k allowed). */
export const fretDistance = (k: number) => 1 - 2 ** (-k / 12);
/** Inverse of fretDistance. */
export const distanceToFret = (d: number) => -12 * Math.log2(1 - Math.min(0.999, d));
/** Centre of fret space n (where a finger presses to play fret n). */
export const fretSpaceCentre = (n: number) => (fretDistance(n - 1) + fretDistance(n)) / 2;

/** Half the fingerboard width as a fraction of the scale length, at the nut and at fret 12. */
const HALF_WIDTH: Record<InstrumentKind, [number, number]> = {
  bass: [0.022, 0.032],
  guitar: [0.033, 0.04],
};

export interface NeckModel {
  instrument: InstrumentKind;
  /** Point on the neck centre line at D = 0 reference (the first mark), and unit vectors. */
  origin: Point;
  axis: Point;
  normal: Point;
  /** s(D) = (p D + q) / (r D + 1): image distance along the axis from `origin`. */
  p: number;
  q: number;
  r: number;
}

/** Image distance along the axis for scale fraction D. */
export function axisPosition(m: NeckModel, d: number): number {
  return (m.p * d + m.q) / (m.r * d + 1);
}

/** Scale fraction D for an image distance s along the axis. */
export function axisToDistance(m: NeckModel, s: number): number {
  return (s - m.q) / (m.p - m.r * s);
}

/** Image point on the neck at fret position `fret` (fractional) and lateral position t ∈ [-1, 1]. */
export function neckPoint(m: NeckModel, fret: number, t: number): Point {
  const d = fretDistance(fret);
  const s = axisPosition(m, d);
  const w = halfWidthPx(m, d) * t;
  return [m.origin[0] + m.axis[0] * s + m.normal[0] * w, m.origin[1] + m.axis[1] * s + m.normal[1] * w];
}

/** Half-width of the fingerboard in pixels at scale fraction D. */
export function halfWidthPx(m: NeckModel, d: number): number {
  const [hw0, hw12] = HALF_WIDTH[m.instrument];
  const frac = hw0 + (hw12 - hw0) * Math.min(1.6, d / 0.5);
  // Local pixels per scale length (derivative of s(D)) keeps the width consistent with perspective.
  const ds = (m.p - m.q * m.r) / (m.r * d + 1) ** 2;
  return Math.abs(ds) * frac;
}

/** Fret position (fractional, 0 = nut) of an image point, and its lateral position t. */
export function pointToFret(m: NeckModel, pt: Point): { fret: number; t: number } {
  const dx = pt[0] - m.origin[0];
  const dy = pt[1] - m.origin[1];
  const s = dx * m.axis[0] + dy * m.axis[1];
  const d = axisToDistance(m, s);
  const lat = dx * m.normal[0] + dy * m.normal[1];
  return { fret: distanceToFret(d), t: lat / Math.max(1e-6, halfWidthPx(m, d)) };
}

/**
 * Build the neck model from 2 or 3 marks. The axis runs from the lowest-fret mark towards
 * the highest one (towards the body); a third mark bends the along-neck mapping for perspective.
 */
export function calibrateNeck(marks: FretMark[], instrument: InstrumentKind): NeckModel {
  const sorted = [...marks].sort((a, b) => a.fret - b.fret);
  if (sorted.length < 2) throw new Error('Mark at least two frets');
  if (new Set(sorted.map((m) => m.fret)).size !== sorted.length) throw new Error('Mark two different frets');
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const len = Math.hypot(last.x - first.x, last.y - first.y);
  if (len < 4) throw new Error('The marks are too close together');
  const axis: Point = [(last.x - first.x) / len, (last.y - first.y) / len];
  const normal: Point = [-axis[1], axis[0]];
  const origin: Point = [first.x, first.y];
  const s = sorted.map((m) => (m.x - first.x) * axis[0] + (m.y - first.y) * axis[1]);
  const d = sorted.map((m) => fretSpaceCentre(m.fret));

  if (sorted.length === 2) {
    // Affine: s = p D + q.
    const p = (s[1] - s[0]) / (d[1] - d[0]);
    return { instrument, origin, axis, normal, p, q: s[0] - p * d[0], r: 0 };
  }
  // Projective through three points: s (r D + 1) = p D + q  →  p D + q - s r D = s.
  const rows = sorted.slice(0, 3).map((_, i) => [d[i], 1, -s[i] * d[i], s[i]]);
  const sol = solve3(rows);
  // Reject fits that fold over within the neck (denominator crossing zero on 0..1).
  if (!sol || sol[2] * 1 + 1 <= 0.2 || sol[2] * 0 + 1 <= 0.2) {
    const p = (s[s.length - 1] - s[0]) / (d[d.length - 1] - d[0]);
    return { instrument, origin, axis, normal, p, q: s[0] - p * d[0], r: 0 };
  }
  return { instrument, origin, axis, normal, p: sol[0], q: sol[1], r: sol[2] };
}

/** Gaussian elimination for a 3×3 system given as rows [a, b, c, rhs]. */
function solve3(rows: number[][]): number[] | null {
  const m = rows.map((r) => [...r]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** Image segment of fret wire k (across the full board width). */
export function fretWire(m: NeckModel, k: number): [Point, Point] {
  return [neckPoint(m, k, -1), neckPoint(m, k, 1)];
}

/** Fret spaces that carry position markers on most instruments. */
export const INLAY_FRETS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
