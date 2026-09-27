/**
 * Synthetic playthrough footage: a bass fretboard (equal-tempered frets, strings, block inlays)
 * over a textured background, with an optional dark "fretting hand" covering some frets.
 *
 * `renderFretboard` is self-contained (no imports, no outer references) so browser tests can
 * send its source into a page with `renderFretboard.toString()`.
 */

export interface FretboardPose {
  /** Nut position in pixels (may be outside the frame). */
  nutX: number;
  nutY: number;
  /** Neck direction in degrees (0 = pointing right, positive = downwards). */
  angle: number;
  /** Scale length in pixels. */
  scale: number;
}

export interface HandPose {
  /** Covered stretch, as fractional fret positions. */
  from: number;
  to: number;
}

/** Grayscale frame, row-major, values 0..255. */
export function renderFretboard(width: number, height: number, pose: FretboardPose, hand: HandPose | null): Float32Array {
  const out = new Float32Array(width * height);
  const rad = (pose.angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const L = pose.scale;
  const inlays = [3, 5, 7, 9, 12, 15, 17, 19, 21];
  const fretAt = (d: number) => -12 * Math.log2(1 - Math.min(0.999, d));
  const dist = (k: number) => 1 - Math.pow(2, -k / 12);
  const boardEnd = dist(21.4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - pose.nutX;
      const dy = y - pose.nutY;
      const s = dx * ux + dy * uy;
      const t = -dx * uy + dy * ux;
      const d = s / L;
      // Background: smooth texture with some structure so the scene isn't flat.
      let v = 55 + 18 * Math.sin(x / 11) * Math.cos(y / 17) + 10 * Math.sin((x + 2 * y) / 29);
      const hw = L * (0.022 + 0.02 * Math.min(1.6, d / 0.5));
      if (d > 0 && d < boardEnd && Math.abs(t) <= hw) {
        v = 205;
        const f = fretAt(d);
        const nearest = Math.round(f);
        const wirePx = Math.abs(d - dist(nearest)) * L;
        if (nearest >= 1 && wirePx < 1.2) v = 95;
        // Inlay blocks in the middle of marked fret spaces.
        const space = Math.ceil(f);
        if (inlays.includes(space)) {
          const centre = (dist(space - 1) + dist(space)) / 2;
          const halfLen = ((dist(space) - dist(space - 1)) * L) / 4;
          const blockHalfWidth = space === 12 ? hw * 0.75 : hw * 0.45;
          if (Math.abs(d - centre) * L < halfLen && Math.abs(t) < blockHalfWidth) v = 60;
        }
        // Four strings.
        for (const k of [-0.75, -0.25, 0.25, 0.75]) if (Math.abs(t - k * hw) < 0.7) v = Math.min(v, 140);
      }
      if (hand && d > 0) {
        const f = fretAt(d);
        if (f >= hand.from && f <= hand.to && Math.abs(t) <= hw * 1.6 + 4) v = 38 + 8 * Math.sin(x / 5 + y / 7);
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/** Image position of fret space `n`'s centre on the neck centre line (for calibration taps). */
export function fretSpacePoint(pose: FretboardPose, n: number): [number, number] {
  const dist = (k: number) => 1 - Math.pow(2, -k / 12);
  const s = ((dist(n - 1) + dist(n)) / 2) * pose.scale;
  const rad = (pose.angle * Math.PI) / 180;
  return [pose.nutX + s * Math.cos(rad), pose.nutY + s * Math.sin(rad)];
}
