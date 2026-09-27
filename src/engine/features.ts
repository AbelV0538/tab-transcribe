/** Signal features computed directly from the audio (timbre per note, onset envelope, tuning). */
import { magnitudeSpectrum } from './fft';
import type { NoteFeatures } from './types';

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

const N_HARMONICS = 8;

function rms(signal: Float32Array, from: number, to: number): number {
  from = Math.max(0, from);
  to = Math.min(signal.length, to);
  if (to <= from) return 0;
  let s = 0;
  for (let i = from; i < to; i++) s += signal[i] * signal[i];
  return Math.sqrt(s / (to - from));
}

/** Peak magnitude near `bin` (± `radius` bins) and its interpolated position. */
function peakNear(mag: Float64Array, bin: number, radius: number): { amp: number; pos: number } {
  const lo = Math.max(1, Math.floor(bin - radius));
  const hi = Math.min(mag.length - 2, Math.ceil(bin + radius));
  let best = lo;
  for (let i = lo; i <= hi; i++) if (mag[i] > mag[best]) best = i;
  // Parabolic interpolation on log magnitude for sub-bin precision.
  const a = Math.log(mag[best - 1] + 1e-12);
  const b = Math.log(mag[best] + 1e-12);
  const c = Math.log(mag[best + 1] + 1e-12);
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return { amp: mag[best], pos: best + Math.max(-0.5, Math.min(0.5, delta)) };
}

/**
 * Measure timbre descriptors for each note. The analysis window starts shortly after the
 * onset (skipping the pick/finger transient) and is long enough to resolve the harmonics
 * of a low B on a 5-string bass.
 */
export function computeNoteFeatures(
  audio: Float32Array,
  sampleRate: number,
  notes: ReadonlyArray<{ pitch: number; start: number; end: number; onsetStrength?: number }>,
): NoteFeatures[] {
  const n = 4096;
  const binHz = sampleRate / n;
  const peak = maxAbs(audio);
  return notes.map((note) => {
    const onset = Math.round(note.start * sampleRate);
    const pre = rms(audio, onset - Math.round(0.05 * sampleRate), onset - Math.round(0.005 * sampleRate));
    const post = rms(audio, onset, onset + Math.round(0.05 * sampleRate));
    const attack = post / (pre + 1e-4 * peak + 1e-9);

    const f0 = midiToHz(note.pitch);
    const duration = note.end - note.start;
    const empty: NoteFeatures = { fundamentalDominance: null, harmonicCentroid: null, attack, cents: null, onsetStrength: note.onsetStrength ?? 1 };
    if (duration < 0.06 || f0 * 2 > sampleRate / 2) return empty;

    const start = onset + Math.round(0.03 * sampleRate);
    const mag = magnitudeSpectrum(audio, start, n);
    const harmonics: number[] = [];
    let strongest = { amp: 0, pos: 0, k: 1 };
    for (let k = 1; k <= N_HARMONICS; k++) {
      const f = f0 * k;
      if (f > sampleRate / 2 - 2 * binHz) break;
      const bin = f / binHz;
      const p = peakNear(mag, bin, Math.max(1, bin * 0.03));
      harmonics.push(p.amp);
      // Only harmonics above ~250 Hz give a precise frequency estimate at this resolution.
      if (f > 250 && k <= 4 && p.amp > strongest.amp) strongest = { ...p, k };
    }
    const energy = harmonics.reduce((s, a) => s + a * a, 0);
    const total = sumSquares(mag);
    // Too quiet relative to everything else in the window: descriptors would be noise.
    if (energy <= 0 || energy < 0.02 * total) return empty;
    let centroid = 0;
    harmonics.forEach((a, i) => (centroid += (i + 1) * a * a));
    let cents: number | null = null;
    if (strongest.amp > 0) {
      const measured = (strongest.pos * binHz) / strongest.k;
      const c = 1200 * Math.log2(measured / f0);
      if (Math.abs(c) < 60) cents = c;
    }
    return {
      fundamentalDominance: (harmonics[0] * harmonics[0]) / energy,
      harmonicCentroid: centroid / energy,
      attack,
      cents,
      onsetStrength: note.onsetStrength ?? 1,
    };
  });
}

function sumSquares(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return s;
}

function maxAbs(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]);
    if (v > m) m = v;
  }
  return m;
}

/**
 * Log-compressed spectral-flux onset strength envelope (hop 256 → ~86 frames/s at 22.05 kHz).
 */
export function onsetEnvelope(audio: Float32Array, sampleRate: number): { envelope: Float32Array; rate: number } {
  const n = 1024;
  const hop = 256;
  const frames = Math.max(1, Math.floor(audio.length / hop));
  const envelope = new Float32Array(frames);
  let prev: Float64Array | null = null;
  // Only up to ~5.5 kHz: plucked-string onsets are well represented there.
  const maxBin = Math.min(n / 2, Math.round((5500 * n) / sampleRate));
  for (let f = 0; f < frames; f++) {
    const mag = magnitudeSpectrum(audio, f * hop - n / 2, n);
    const cur = new Float64Array(maxBin);
    for (let i = 0; i < maxBin; i++) cur[i] = Math.log1p(100 * mag[i]);
    if (prev) {
      let flux = 0;
      for (let i = 1; i < maxBin; i++) {
        const d = cur[i] - prev[i];
        if (d > 0) flux += d;
      }
      envelope[f] = flux;
    }
    prev = cur;
  }
  return { envelope, rate: sampleRate / hop };
}

/** Amplitude-weighted median of per-note cents deviations (global tuning of the recording). */
export function estimateTuningCents(notes: ReadonlyArray<{ amplitude: number; features: NoteFeatures }>): number | null {
  const values = notes
    .filter((n) => n.features.cents !== null)
    .map((n) => ({ c: n.features.cents as number, w: n.amplitude }))
    .sort((a, b) => a.c - b.c);
  if (values.length < 5) return null;
  const total = values.reduce((s, v) => s + v.w, 0);
  let acc = 0;
  for (const v of values) {
    acc += v.w;
    if (acc >= total / 2) return Math.round(v.c);
  }
  return null;
}

/**
 * Snap note onsets to the nearest preceding peak of the broadband onset envelope.
 * The note model reacts late to low notes (its low-frequency analysis needs a longer
 * window), so bass notes can start 30-60 ms late; the pluck transient is broadband and
 * pins down the true onset. The search window shrinks for higher notes.
 */
export function refineOnsets<T extends { pitch: number; start: number; end: number }>(
  notes: T[],
  envelope: Float32Array,
  rate: number,
): Array<T & { onsetStrength: number }> {
  const n = envelope.length;
  return notes.map((note) => {
    let ref = 0;
    const r0 = Math.max(0, Math.floor((note.start - 0.25) * rate));
    const r1 = Math.min(n - 1, Math.ceil((note.start + 0.25) * rate));
    for (let i = r0; i <= r1; i++) ref = Math.max(ref, envelope[i]);
    const near = (t: number) => {
      let m = 0;
      for (let i = Math.max(0, Math.floor((t - 0.02) * rate)); i <= Math.min(n - 1, Math.ceil((t + 0.02) * rate)); i++) m = Math.max(m, envelope[i]);
      return ref > 0 ? m / ref : 0;
    };
    const back = 0.015 + 0.065 * Math.max(0, Math.min(1, (64 - note.pitch) / 36));
    const a = Math.max(1, Math.floor((note.start - back) * rate));
    const b = Math.min(n - 2, Math.ceil((note.start + 0.012) * rate));
    let best = -1;
    for (let i = a; i <= b; i++) {
      if (envelope[i] >= envelope[i - 1] && envelope[i] >= envelope[i + 1] && (best < 0 || envelope[i] > envelope[best])) best = i;
    }
    if (best < 0 || envelope[best] < 0.4 * ref) return { ...note, onsetStrength: near(note.start) };
    // Parabolic interpolation for sub-frame precision.
    const y0 = envelope[best - 1];
    const y1 = envelope[best];
    const y2 = envelope[best + 1];
    const denom = y0 - 2 * y1 + y2;
    const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
    const start = (best + delta) / rate;
    const onsetStrength = ref > 0 ? envelope[best] / ref : 0;
    return start < note.end - 0.02 ? { ...note, start, onsetStrength } : { ...note, onsetStrength: near(note.start) };
  });
}
