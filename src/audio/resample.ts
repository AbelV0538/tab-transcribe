/**
 * Sample-rate conversion that works anywhere (web workers, Node), unlike OfflineAudioContext.
 */

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 60; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

const TAPS = 95;
/** Cut-off as a fraction of the input rate: 10.3 kHz at 44.1 kHz. */
const CUTOFF = 10300 / 44100;
/** Kaiser β ≈ 7 gives ~70 dB of stop-band attenuation (from ~11.3 kHz at 44.1 kHz). */
const BETA = 7;

let taps: Float32Array | null = null;

/** Low-pass FIR for 2:1 decimation: a Kaiser-windowed sinc with unity DC gain. */
function decimationTaps(): Float32Array {
  if (taps) return taps;
  const h = new Float64Array(TAPS);
  const mid = (TAPS - 1) / 2;
  const i0Beta = besselI0(BETA);
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const t = i - mid;
    const sinc = t === 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * t) / (Math.PI * t);
    const r = t / mid;
    h[i] = sinc * (besselI0(BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0Beta);
    sum += h[i];
  }
  taps = Float32Array.from(h, (v) => v / sum);
  return taps;
}

/**
 * Halve the sample rate (e.g. 44.1 → 22.05 kHz) with an anti-aliasing low-pass filter.
 * Zero-phase: output sample m is input sample 2m, so timing is preserved exactly.
 */
export function halveRate(x: Float32Array): Float32Array {
  const h = decimationTaps();
  const mid = (TAPS - 1) / 2;
  const out = new Float32Array(Math.ceil(x.length / 2));
  const n = x.length;
  for (let m = 0; m < out.length; m++) {
    const first = 2 * m - mid;
    let acc = 0;
    if (first >= 0 && first + TAPS <= n) {
      for (let k = 0; k < TAPS; k++) acc += h[k] * x[first + k];
    } else {
      for (let k = 0; k < TAPS; k++) {
        const i = first + k;
        if (i >= 0 && i < n) acc += h[k] * x[i];
      }
    }
    out[m] = acc;
  }
  return out;
}
