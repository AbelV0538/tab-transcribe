/**
 * Instrument separation with HTDemucs (Rouard, Massa & Défossez, Meta AI; MIT licence), the
 * 6-stem variant that also has guitar and piano stems. Environment-agnostic: the network runs
 * behind `StemModel`, which ONNX Runtime Web (browser) and ONNX Runtime Node (tests) implement.
 *
 * Follows Demucs' own `separate`/`apply_model`: the mix is normalised by the mean and standard
 * deviation of its mono downmix, cut into 7.8 s segments with 25 % overlap, and the segments
 * are cross-faded with Demucs' triangular weighting.
 */
import info from './modelInfo.json';

export type StemName = 'drums' | 'bass' | 'other' | 'vocals' | 'guitar' | 'piano';

/** Order of the stems in the model's output. */
export const STEM_ORDER = info.stems as StemName[];
/** Sample rate of the model's input and output. */
export const SEPARATION_RATE: number = info.sampleRate;
/** Samples per segment (7.8 s); the exported network only accepts exactly this length. */
export const SEGMENT: number = info.segment;
export const OVERLAP = 0.25;

export interface StemModel {
  /**
   * Separate one segment. Input: planar stereo, `[left × SEGMENT, right × SEGMENT]`.
   * Output: `[stem][channel][sample]` for every stem in `STEM_ORDER`.
   */
  run(planarStereo: Float32Array): Promise<Float32Array>;
}

/** Demucs' segment weight (`transition_power = 1`): a triangle that never reaches zero. */
function triangle(n: number): Float32Array {
  const w = new Float32Array(n);
  const half = Math.floor(n / 2);
  for (let i = 0; i < n; i++) w[i] = i < half ? i + 1 : n - i;
  const max = Math.max(half, n - half);
  for (let i = 0; i < n; i++) w[i] /= max;
  return w;
}

/** Start offsets of the segments covering `length` samples. */
export function segmentOffsets(length: number): number[] {
  const stride = Math.floor((1 - OVERLAP) * SEGMENT);
  const out: number[] = [];
  for (let o = 0; o < Math.max(1, length); o += stride) out.push(o);
  return out;
}

/**
 * Separate stereo audio at `SEPARATION_RATE` and return the `wanted` stems as mono at the same
 * rate. Only the wanted stems are accumulated, so memory grows with duration × wanted stems.
 * `onProgress` gets the fraction of segments done.
 */
export async function separate(
  left: Float32Array,
  right: Float32Array,
  model: StemModel,
  wanted: readonly StemName[],
  onProgress: (fraction: number) => void = () => {},
): Promise<Partial<Record<StemName, Float32Array>>> {
  if (right.length !== left.length) throw new Error('Both channels must have the same length');
  const length = left.length;

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < length; i++) {
    const m = 0.5 * (left[i] + right[i]);
    sum += m;
    sumSq += m * m;
  }
  const mean = length ? sum / length : 0;
  const variance = length ? Math.max(0, sumSq / length - mean * mean) : 0;
  const std = variance > 1e-16 ? Math.sqrt(variance) : 1;

  const indices = wanted.map((s) => {
    const k = STEM_ORDER.indexOf(s);
    if (k < 0) throw new Error(`Unknown stem "${s}"`);
    return k;
  });
  const acc = wanted.map(() => new Float32Array(length));
  const weightSum = new Float32Array(length);
  const weight = triangle(SEGMENT);
  const input = new Float32Array(2 * SEGMENT);
  const offsets = segmentOffsets(length);

  for (let s = 0; s < offsets.length; s++) {
    const o = offsets[s];
    const n = Math.min(SEGMENT, length - o);
    input.fill(0);
    for (let i = 0; i < n; i++) {
      input[i] = (left[o + i] - mean) / std;
      input[SEGMENT + i] = (right[o + i] - mean) / std;
    }
    const out = await model.run(input);
    if (out.length < STEM_ORDER.length * 2 * SEGMENT) throw new Error(`Separation model returned ${out.length} values, expected ${STEM_ORDER.length * 2 * SEGMENT}`);
    indices.forEach((k, w) => {
      const l = k * 2 * SEGMENT;
      const r = l + SEGMENT;
      const a = acc[w];
      for (let i = 0; i < n; i++) a[o + i] += weight[i] * 0.5 * (out[l + i] + out[r + i]);
    });
    for (let i = 0; i < n; i++) weightSum[o + i] += weight[i];
    onProgress((s + 1) / offsets.length);
  }

  const result: Partial<Record<StemName, Float32Array>> = {};
  wanted.forEach((name, w) => {
    const a = acc[w];
    for (let i = 0; i < length; i++) a[i] = (a[i] / weightSum[i]) * std + mean;
    result[name] = a;
  });
  return result;
}
