/**
 * Tempo estimation, beat tracking (dynamic programming, after Ellis 2007), downbeat and
 * subdivision choice, and quantisation of note times onto the resulting grid.
 */

export interface BeatGrid {
  /** Beat times in seconds, extended to cover the whole recording (and a bit before it). */
  beats: number[];
  /** Index in `beats` of the first bar line (at or before the first note). */
  firstDownbeat: number;
  beatsPerBar: number;
  /** Grid slots per beat: 4 = sixteenth notes, 3 = eighth-note triplets. */
  subdivision: number;
  /** Tempo in beats per minute (median). */
  bpm: number;
}

export interface OnsetHint {
  time: number;
  /** Relative weight, e.g. amplitude; low notes are weighted up for downbeat detection. */
  weight: number;
  pitch: number;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Normalised onset strength: envelope plus smoothed note-onset impulses. */
export function onsetStrength(envelope: Float32Array, rate: number, onsets: OnsetHint[]): Float64Array {
  const n = envelope.length;
  const out = new Float64Array(n);
  // Remove slow trend (running mean over ~0.5 s) and keep positive part.
  const half = Math.round(rate * 0.25);
  let acc = 0;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + envelope[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = Math.max(0, envelope[i] - (prefix[b] - prefix[a]) / (b - a));
    acc += out[i] * out[i];
  }
  const std = Math.sqrt(acc / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= std;
  // Note onsets from the transcription are a cleaner rhythmic cue: blend them in.
  const maxW = Math.max(1e-9, ...onsets.map((o) => o.weight));
  for (const o of onsets) {
    const c = Math.round(o.time * rate);
    for (let d = -2; d <= 2; d++) {
      const i = c + d;
      if (i >= 0 && i < n) out[i] += (1.5 * o.weight * Math.exp(-(d * d) / 2)) / maxW;
    }
  }
  return out;
}

/** Estimate the beat period in frames by autocorrelation with a log-normal tempo prior. */
export function estimatePeriod(strength: Float64Array, rate: number, minBpm = 50, maxBpm = 220): number {
  const minLag = Math.floor((60 * rate) / maxBpm);
  const maxLag = Math.min(strength.length - 1, Math.ceil((60 * rate) / minBpm));
  const n = strength.length;
  if (maxLag <= minLag) return (60 * rate) / 120;
  const ac = new Float64Array(2 * maxLag + 2);
  for (let lag = minLag - 1; lag < ac.length; lag++) {
    if (lag <= 0 || lag >= n) continue;
    let s = 0;
    for (let i = lag; i < n; i++) s += strength[i] * strength[i - lag];
    ac[lag] = s / (n - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * rate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.8) ** 2);
    // Reward periods whose double is also periodic (bar-level consistency).
    const lag2 = 2 * lag < ac.length ? ac[2 * lag] : 0;
    const score = (ac[lag] + 0.5 * lag2) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic refinement.
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return best + Math.max(-0.5, Math.min(0.5, delta));
}

/** Dynamic-programming beat tracker. Returns beat frame indices. */
export function trackBeatFrames(strength: Float64Array, period: number, tightness = 100): number[] {
  const n = strength.length;
  if (n === 0) return [];
  // Local score: onset strength smoothed with a Gaussian of width period/32.
  const sigma = Math.max(1, period / 32);
  const radius = Math.ceil(3 * sigma);
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -radius; d <= radius; d++) {
      const j = i + d;
      if (j >= 0 && j < n) s += strength[j] * Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    local[i] = s;
  }
  const cum = new Float64Array(n);
  const prev = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  const penalty = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) penalty[d] = -tightness * Math.log(d / period) ** 2;
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = lo; d <= hi; d++) {
      const j = i - d;
      if (j < 0) break;
      const v = cum[j] + penalty[d];
      if (v > best) {
        best = v;
        arg = j;
      }
    }
    cum[i] = local[i] + (arg >= 0 ? best : 0);
    prev[i] = arg;
  }
  // Last beat: the best cumulative score within the final period.
  let last = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) {
    if (cum[i] > bestEnd) {
      bestEnd = cum[i];
      last = i;
    }
  }
  const beats: number[] = [];
  for (let i = last; i >= 0; i = prev[i]) beats.push(i);
  beats.reverse();
  // Drop leading beats before any real activity.
  const threshold = 0.05 * Math.max(...local);
  while (beats.length > 1 && local[beats[0]] < threshold) beats.shift();
  return beats;
}

/** Extend a beat list backwards/forwards with its edge periods so it covers [from, to]. */
function extendBeats(beats: number[], period: number, from: number, to: number): number[] {
  const out = [...beats];
  if (out.length === 0) out.push(0);
  const headP = out.length > 1 ? out[1] - out[0] : period;
  while (out[0] > from) out.unshift(out[0] - headP);
  const tailP = out.length > 1 ? out[out.length - 1] - out[out.length - 2] : period;
  while (out[out.length - 1] < to) out.push(out[out.length - 1] + tailP);
  return out;
}

/** Fractional beat position of time t on the grid (index into beats). */
export function beatPosition(beats: number[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  if (t <= beats[0]) return (t - beats[0]) / (beats[1] - beats[0]);
  if (t >= beats[hi]) return hi + (t - beats[hi]) / (beats[hi] - beats[hi - 1]);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - beats[lo]) / (beats[lo + 1] - beats[lo]);
}

function timeAtBeat(beats: number[], pos: number): number {
  const i = Math.max(0, Math.min(beats.length - 2, Math.floor(pos)));
  return beats[i] + (pos - i) * (beats[i + 1] - beats[i]);
}

/** Choose 16th-note vs triplet subdivision from where onsets fall within the beat. */
export function chooseSubdivision(beats: number[], onsets: number[]): number {
  let straight = 0;
  let triplet = 0;
  for (const t of onsets) {
    const pos = beatPosition(beats, t);
    const frac = pos - Math.floor(pos);
    const near = (x: number) => Math.abs(frac - x) < 0.06;
    if (near(0.25) || near(0.75)) straight++;
    if (near(1 / 3) || near(2 / 3)) triplet++;
  }
  return triplet >= 6 && triplet > 1.3 * straight ? 3 : 4;
}

export interface GridOptions {
  duration: number;
  /** Fixed tempo; null to estimate. */
  bpm: number | null;
  beatsPerBar: number;
  /** 'auto', 4 (sixteenths) or 3 (triplets). */
  subdivision: 'auto' | 3 | 4;
}

export function buildBeatGrid(envelope: Float32Array, rate: number, onsets: OnsetHint[], opts: GridOptions): BeatGrid {
  const strength = onsetStrength(envelope, rate, onsets);
  let beatTimes: number[];
  let period: number;
  if (opts.bpm && opts.bpm > 0) {
    period = (60 * rate) / opts.bpm;
    // Fixed grid: choose the phase that best aligns with onsets.
    let bestPhase = 0;
    let bestScore = -Infinity;
    for (let phase = 0; phase < period; phase++) {
      let s = 0;
      for (let f = phase; f < strength.length; f += period) s += strength[Math.round(f)] ?? 0;
      if (s > bestScore) {
        bestScore = s;
        bestPhase = phase;
      }
    }
    beatTimes = [];
    for (let f = bestPhase; f < strength.length; f += period) beatTimes.push(f / rate);
  } else {
    period = estimatePeriod(strength, rate);
    beatTimes = trackBeatFrames(strength, period).map((f) => f / rate);
    if (beatTimes.length < 2) {
      beatTimes = [];
      for (let f = 0; f < strength.length; f += period) beatTimes.push(f / rate);
    }
  }
  const periodSec = period / rate;
  let beats = extendBeats(beatTimes, periodSec, -periodSec, opts.duration + 2 * periodSec);

  const onsetTimes = onsets.map((o) => o.time);
  if (!opts.bpm && onsetTimes.length > 8) {
    // If many onsets sit on odd eighths of the beat, the tracker locked to half tempo.
    let odd = 0;
    for (const t of onsetTimes) {
      const pos = beatPosition(beats, t);
      const frac = pos - Math.floor(pos);
      if ([0.125, 0.375, 0.625, 0.875].some((x) => Math.abs(frac - x) < 0.04)) odd++;
    }
    const bpmNow = 60 / median(beats.slice(1).map((b, i) => b - beats[i]));
    if (odd / onsetTimes.length > 0.25 && bpmNow < 110) {
      const doubled: number[] = [];
      beats.forEach((b, i) => {
        doubled.push(b);
        if (i + 1 < beats.length) doubled.push((b + beats[i + 1]) / 2);
      });
      beats = doubled;
    }
  }

  const subdivision = opts.subdivision === 'auto' ? chooseSubdivision(beats, onsetTimes) : opts.subdivision;

  // Downbeat phase: bars start where low/strong onsets concentrate.
  const B = Math.max(1, opts.beatsPerBar);
  const phaseScore = new Array<number>(B).fill(0);
  for (const o of onsets) {
    const pos = beatPosition(beats, o.time);
    const nearest = Math.round(pos);
    if (Math.abs(pos - nearest) > 0.15) continue;
    const lowBoost = 1 + Math.max(0, Math.min(1.5, (55 - o.pitch) / 15));
    phaseScore[((nearest % B) + B) % B] += o.weight * lowBoost;
  }
  // Prior: recordings usually start on a downbeat, so favour the phase of the first onset.
  const firstNote = onsetTimes.length ? Math.min(...onsetTimes) : 0;
  const firstBeat = Math.round(beatPosition(beats, firstNote));
  const totalScore = phaseScore.reduce((a, b) => a + b, 0);
  phaseScore[((firstBeat % B) + B) % B] += 0.15 * totalScore;
  let phase = 0;
  phaseScore.forEach((s, i) => {
    if (s > phaseScore[phase]) phase = i;
  });
  // Last downbeat at or before the first note (quantised), extending backwards if needed.
  const firstPos = Math.round(beatPosition(beats, firstNote) * subdivision) / subdivision;
  let first = Math.floor(firstPos);
  while (((first % B) + B) % B !== phase) first--;
  while (first < 0) {
    beats.unshift(beats[0] - (beats[1] - beats[0]));
    first++;
  }

  const intervals = beats.slice(1).map((b, i) => b - beats[i]);
  return { beats, firstDownbeat: first, beatsPerBar: B, subdivision, bpm: Math.round(60 / median(intervals)) };
}

/** Grid slot (integer) nearest to time t; slot 0 is the first downbeat. */
export function timeToSlot(grid: BeatGrid, t: number): number {
  return Math.round((beatPosition(grid.beats, t) - grid.firstDownbeat) * grid.subdivision);
}

export function slotToTime(grid: BeatGrid, slot: number): number {
  return timeAtBeat(grid.beats, grid.firstDownbeat + slot / grid.subdivision);
}

export function slotsPerBar(grid: BeatGrid): number {
  return grid.beatsPerBar * grid.subdivision;
}
