/**
 * Instrument detection (guitar, bass or both) and assignment of detected notes to instruments.
 *
 * The note detector is instrument-agnostic, so each note is scored with a log-likelihood
 * ratio "bass vs guitar" built from cues a player would use:
 *  - register: a 4-string bass lives an octave below the guitar (E1 = MIDI 28 vs E2 = 40),
 *    anything below D2 cannot be a guitar in common tunings and anything above G4 is
 *    beyond a bass's usual reach;
 *  - voice: bass lines are the lowest, mostly monophonic voice;
 *  - chord context: notes stacked a fifth/fourth above the lowest note with the same onset
 *    form power chords/triads (guitar), a low note an octave or more under a chord is bass;
 *  - timbre: bass notes have a dominant fundamental, guitar notes are overtone-rich.
 * Global presence of each instrument is decided from the amount of confident evidence, and
 * when both are present the bass line is extracted as the best-scoring monophonic subset.
 */
import type { RawNote } from '../engine/types';

export type InstrumentMode = 'auto' | 'guitar' | 'bass' | 'both';

export interface InstrumentPresence {
  present: boolean;
  /** 0..1 confidence that the instrument is playing. */
  confidence: number;
  /** Number of notes that are strong evidence for this instrument. */
  evidence: number;
}

export interface DetectionResult {
  guitar: InstrumentPresence;
  bass: InstrumentPresence;
  guitarNotes: RawNote[];
  bassNotes: RawNote[];
  /** Notes judged to be overtones / artefacts and discarded. */
  discarded: number;
  /** Per-input-note bass log-likelihood ratio (for visualisation/debugging). */
  scores: number[];
}

interface NoteContext {
  lowestFrac: number;
  groupSize: number;
  rank: number;
  intervalUp: number | null;
  /** Index of a stronger simultaneous note this one may be an overtone of (-1 if none). */
  overtoneOf: number;
  /** Amplitude relative to that note. */
  overtoneRatio: number;
  /**
   * True when the note's onset group holds nothing but a root and its possible overtones,
   * i.e. no independent chord tone that would show a second instrument is playing.
   */
  isolated: boolean;
  /** Starts while a stronger note at a harmonic interval below is still ringing. */
  overtoneOfSounding: boolean;
}

const GROUP_WINDOW = 0.05;
const TIMELINE_RATE = 50;
/** Octave, octave + fifth and two octaves: where the note model most often hallucinates. */
const OVERTONE_INTERVALS = new Set([12, 19, 24, 36]);

/** Piecewise-linear prior on pitch: positive favours bass. */
const PITCH_KNOTS: Array<[number, number]> = [
  [23, 7],
  [35, 6],
  [36, 3.5],
  [38, 2.8],
  [39, 2.3],
  [40, 0.4],
  [43, 0.2],
  [45, 0],
  [48, -0.4],
  [50, -0.8],
  [52, -1.3],
  [55, -2.2],
  [60, -3.2],
  [64, -4],
  [67, -5],
  [68, -10],
  [110, -10],
];

export function pitchPrior(pitch: number): number {
  if (pitch <= PITCH_KNOTS[0][0]) return PITCH_KNOTS[0][1];
  for (let i = 1; i < PITCH_KNOTS.length; i++) {
    const [p1, v1] = PITCH_KNOTS[i];
    if (pitch <= p1) {
      const [p0, v0] = PITCH_KNOTS[i - 1];
      return v0 + ((v1 - v0) * (pitch - p0)) / (p1 - p0);
    }
  }
  return PITCH_KNOTS[PITCH_KNOTS.length - 1][1];
}

function computeContext(notes: RawNote[]): NoteContext[] {
  const ctx: NoteContext[] = notes.map(() => ({ lowestFrac: 0, groupSize: 1, rank: 0, intervalUp: null, overtoneOf: -1, overtoneRatio: 1, isolated: false, overtoneOfSounding: false }));
  if (notes.length === 0) return ctx;

  // Lowest-voice fraction on a coarse timeline.
  const end = Math.max(...notes.map((n) => n.end));
  const len = Math.ceil(end * TIMELINE_RATE) + 1;
  const lowest = new Float32Array(len).fill(Infinity);
  const span = (n: RawNote) => [Math.floor(n.start * TIMELINE_RATE), Math.max(Math.floor(n.start * TIMELINE_RATE) + 1, Math.ceil(n.end * TIMELINE_RATE))];
  for (const n of notes) {
    const [a, b] = span(n);
    for (let t = a; t < b && t < len; t++) if (n.pitch < lowest[t]) lowest[t] = n.pitch;
  }
  notes.forEach((n, i) => {
    const [a, b] = span(n);
    let hit = 0;
    for (let t = a; t < b && t < len; t++) if (lowest[t] === n.pitch) hit++;
    ctx[i].lowestFrac = hit / Math.max(1, b - a);
  });

  // Onset groups (chords / simultaneous attacks).
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].start - notes[b].start);
  let g = 0;
  while (g < order.length) {
    const first = notes[order[g]].start;
    let e = g;
    while (e + 1 < order.length && notes[order[e + 1]].start - first <= GROUP_WINDOW) e++;
    const members = order.slice(g, e + 1).sort((a, b) => notes[a].pitch - notes[b].pitch);
    members.forEach((idx, r) => {
      ctx[idx].groupSize = members.length;
      ctx[idx].rank = r;
      ctx[idx].intervalUp = r + 1 < members.length ? notes[members[r + 1]].pitch - notes[idx].pitch : null;
    });
    // Possible overtone ghosts: a weaker note at a harmonic interval above a note that starts
    // with it and outlasts it.
    for (const hi of members) {
      for (const lo of members) {
        const interval = notes[hi].pitch - notes[lo].pitch;
        if (!OVERTONE_INTERVALS.has(interval)) continue;
        if (Math.abs(notes[hi].start - notes[lo].start) > 0.05 || notes[hi].end > notes[lo].end + 0.1) continue;
        const ratio = notes[hi].amplitude / notes[lo].amplitude;
        if (ratio < 0.95 && (ctx[hi].overtoneOf < 0 || ratio < ctx[hi].overtoneRatio)) {
          ctx[hi].overtoneOf = lo;
          ctx[hi].overtoneRatio = ratio;
        }
      }
    }
    const independent = members.filter((i) => ctx[i].overtoneOf < 0).length;
    for (const i of members) ctx[i].isolated = independent <= 1;
    g = e + 1;
  }
  // Ghosts whose onset was detected separately from the note they shadow.
  const byStart = order;
  byStart.forEach((hi, k) => {
    const h = notes[hi];
    for (let j = k - 1; j >= 0; j--) {
      const l = notes[byStart[j]];
      if (h.start - l.start > 2) break;
      if (l.end > h.start + 0.05 && OVERTONE_INTERVALS.has(h.pitch - l.pitch) && h.amplitude < 0.95 * l.amplitude) {
        ctx[hi].overtoneOfSounding = true;
        break;
      }
    }
  });
  return ctx;
}

/** Log-likelihood ratio that a note was played on bass rather than guitar. */
function bassScore(n: RawNote, c: NoteContext): number {
  let s = pitchPrior(n.pitch);
  s += 2.2 * (c.lowestFrac - 0.5);
  if (c.groupSize >= 2) {
    if (c.rank > 0) {
      s -= 1.5 + 0.3 * Math.min(c.rank, 3);
    } else if (c.intervalUp !== null) {
      if (c.intervalUp >= 12) s += 0.8;
      else if (c.intervalUp === 7 || c.intervalUp === 5) s -= 2.0; // power-chord root
      else if (c.intervalUp <= 4) s -= 1.2; // close-voiced chord
    }
  }
  const fd = n.features.fundamentalDominance;
  if (fd !== null && n.pitch < 57) s += Math.max(-1.5, Math.min(1.5, (fd - 0.45) * 5));
  if (c.overtoneOf >= 0 && c.isolated) s -= 1;
  return s;
}

/**
 * Choose the maximum-weight subset of notes whose onsets are at least `sep` seconds apart
 * (weighted interval scheduling). Returns indices into `idx`.
 */
function bestMonophonicLine(notes: RawNote[], idx: number[], weight: (i: number) => number, sep = 0.06): Set<number> {
  const cand = idx.filter((i) => weight(i) > 0).sort((a, b) => notes[a].start - notes[b].start);
  const n = cand.length;
  const dp = new Float64Array(n + 1);
  const take = new Uint8Array(n + 1);
  const prev = new Int32Array(n + 1);
  for (let k = 1; k <= n; k++) {
    const t = notes[cand[k - 1]].start;
    // Last candidate that starts at least `sep` earlier.
    let lo = 0;
    let hi = k - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (notes[cand[mid - 1]].start <= t - sep) lo = mid;
      else hi = mid - 1;
    }
    prev[k] = lo;
    const withIt = weight(cand[k - 1]) + dp[lo];
    if (withIt > dp[k - 1]) {
      dp[k] = withIt;
      take[k] = 1;
    } else dp[k] = dp[k - 1];
  }
  const chosen = new Set<number>();
  let k = n;
  while (k > 0) {
    if (take[k]) {
      chosen.add(cand[k - 1]);
      k = prev[k];
    } else k--;
  }
  return chosen;
}

function presence(count: number, mass: number, present: boolean): InstrumentPresence {
  const e = Math.min(1, count / 6) * Math.min(1, mass / 0.15);
  return { present, confidence: present ? 0.5 + 0.5 * e : 0.5 * e, evidence: count };
}

export function detectInstruments(notes: RawNote[], mode: InstrumentMode): DetectionResult {
  const ctx = computeContext(notes);
  const scores = notes.map((n, i) => bassScore(n, ctx[i]));
  const weight = (n: RawNote) => n.amplitude * Math.min(1, Math.max(0.05, n.end - n.start));
  const total = notes.reduce((s, n) => s + weight(n), 0) || 1;

  let bassCount = 0;
  let bassMass = 0;
  let guitarCount = 0;
  let guitarMass = 0;
  let meanScore = 0;
  notes.forEach((n, i) => {
    const w = weight(n);
    meanScore += (w * scores[i]) / total;
    // Overtones of a lone note are not evidence of anything.
    if (ctx[i].overtoneOf >= 0 && ctx[i].isolated) return;
    if (scores[i] >= 1.5) {
      bassCount++;
      bassMass += w / total;
    } else if (scores[i] <= -1) {
      guitarCount++;
      guitarMass += w / total;
    }
  });
  const enough = (count: number, mass: number) => (count >= 3 && mass >= 0.06) || (count >= 1 && mass >= 0.3);
  let hasBass = enough(bassCount, bassMass);
  let hasGuitar = enough(guitarCount, guitarMass);
  if (!hasBass && !hasGuitar && notes.length > 0) {
    // Ambiguous register (E2-B2 single notes): guitar is the more common source.
    if (meanScore >= 1.0) hasBass = true;
    else hasGuitar = true;
  }
  if (mode === 'guitar') [hasGuitar, hasBass] = [true, false];
  else if (mode === 'bass') [hasGuitar, hasBass] = [false, true];
  else if (mode === 'both') [hasGuitar, hasBass] = [true, true];

  const all = notes.map((_, i) => i);
  let bassSet = new Set<number>();
  let guitarIdx: number[] = [];
  let discarded = 0;

  if (hasBass && !hasGuitar) {
    // Bass only: keep the most bass-like monophonic line; the rest are overtones or noise.
    bassSet = bestMonophonicLine(notes, all, (i) => {
      const c = ctx[i];
      // A weaker note an octave/twelfth above a ringing bass note is an overtone: never keep it.
      if (c.overtoneOf >= 0 || c.overtoneOfSounding) return -1;
      return notes[i].amplitude * (0.5 + c.lowestFrac) * (c.rank === 0 ? 1.5 : 0.7);
    });
    discarded = notes.length - bassSet.size;
  } else if (hasBass && hasGuitar) {
    bassSet = bestMonophonicLine(
      notes,
      all.filter((i) => !(ctx[i].overtoneOf >= 0 && ctx[i].isolated) && notes[i].pitch <= 67),
      (i) => scores[i] * notes[i].amplitude,
    );
    for (const i of all) {
      if (bassSet.has(i)) continue;
      const ghostOfBass = ctx[i].overtoneOf >= 0 && ctx[i].isolated && bassSet.has(ctx[i].overtoneOf);
      // Below every guitar tuning we support: a bass note that lost to a stronger one.
      if (ghostOfBass || notes[i].pitch < 35) discarded++;
      else guitarIdx.push(i);
    }
  } else {
    // Guitar only: drop clearly weaker octave/twelfth ghosts above single notes.
    guitarIdx = all.filter((i) => !(ctx[i].overtoneOf >= 0 && ctx[i].isolated && ctx[i].overtoneRatio < 0.65));
    discarded = notes.length - guitarIdx.length;
  }

  return {
    guitar: presence(guitarCount, guitarMass, hasGuitar),
    bass: presence(bassCount, bassMass, hasBass),
    guitarNotes: guitarIdx.map((i) => notes[i]),
    bassNotes: all.filter((i) => bassSet.has(i)).map((i) => notes[i]),
    discarded,
    scores,
  };
}
