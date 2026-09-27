/*
 * Converts Basic Pitch frame/onset activations into note events.
 *
 * Port of `output_to_notes_polyphonic` from basic-pitch (Copyright 2022 Spotify AB,
 * Apache-2.0), rewritten over flat Float32Arrays. The "melodia trick" loop uses a sorted
 * candidate list instead of repeatedly scanning for the global maximum, which makes it
 * O(n log n) instead of O(n^2) and fast enough for full songs on a phone.
 */
import { MIDI_OFFSET, N_PITCHES, type ModelActivations } from './basicPitch';
import type { NoteDecodeOptions } from './types';

export interface FrameNote {
  startFrame: number;
  /** Exclusive end frame. */
  endFrame: number;
  pitch: number;
  amplitude: number;
}

function inferOnsets(frames: Float32Array, onsets: Float32Array, nFrames: number): Float32Array {
  const nDiff = 2;
  const diff = new Float32Array(frames.length);
  let diffMax = 0;
  let onsetMax = 0;
  for (let i = 0; i < onsets.length; i++) if (onsets[i] > onsetMax) onsetMax = onsets[i];
  for (let t = nDiff; t < nFrames; t++) {
    for (let p = 0; p < N_PITCHES; p++) {
      const idx = t * N_PITCHES + p;
      const v = frames[idx];
      let m = Infinity;
      for (let n = 1; n <= nDiff; n++) {
        const d = v - frames[idx - n * N_PITCHES];
        if (d < m) m = d;
      }
      if (m > 0) {
        diff[idx] = m;
        if (m > diffMax) diffMax = m;
      }
    }
  }
  const out = new Float32Array(onsets.length);
  const scale = diffMax > 0 ? onsetMax / diffMax : 0;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(onsets[i], diff[i] * scale);
  return out;
}

export function decodeNotes(act: ModelActivations, opts: NoteDecodeOptions): FrameNote[] {
  const { nFrames } = act;
  if (nFrames < 3) return [];
  const minIdx = Math.max(0, opts.minPitch - MIDI_OFFSET);
  const maxIdx = Math.min(N_PITCHES - 1, opts.maxPitch - MIDI_OFFSET);

  // Constrain frequency range (on copies: the activations are cached for re-decoding).
  const frames = new Float32Array(act.frames);
  let onsets: Float32Array = new Float32Array(act.onsets);
  for (let t = 0; t < nFrames; t++) {
    const row = t * N_PITCHES;
    for (let p = 0; p < N_PITCHES; p++) {
      if (p < minIdx || p > maxIdx) {
        frames[row + p] = 0;
        onsets[row + p] = 0;
      }
    }
  }
  if (opts.inferOnsets) onsets = inferOnsets(frames, onsets, nFrames);

  // Onset peaks along time (scipy.signal.argrelmax with order 1) above the onset threshold.
  const starts: Array<[number, number]> = [];
  for (let t = 0; t < nFrames; t++) {
    for (let p = minIdx; p <= maxIdx; p++) {
      const v = onsets[t * N_PITCHES + p];
      if (v <= opts.onsetThreshold) continue;
      const prev = t > 0 ? onsets[(t - 1) * N_PITCHES + p] : -Infinity;
      const next = t < nFrames - 1 ? onsets[(t + 1) * N_PITCHES + p] : -Infinity;
      if (v > prev && v > next) starts.push([t, p]);
    }
  }
  // Latest onsets first, so an earlier note at the same pitch ends where the later one starts.
  starts.sort((a, b) => b[0] - a[0] || b[1] - a[1]);

  const remaining = new Float32Array(frames);
  const thr = opts.frameThreshold;
  const tol = opts.energyTolerance;
  const notes: FrameNote[] = [];

  const clear = (t: number, p: number) => {
    const row = t * N_PITCHES;
    remaining[row + p] = 0;
    if (p < N_PITCHES - 1) remaining[row + p + 1] = 0;
    if (p > 0) remaining[row + p - 1] = 0;
  };
  const meanFrames = (from: number, to: number, p: number) => {
    let s = 0;
    for (let t = from; t < to; t++) s += frames[t * N_PITCHES + p];
    return to > from ? s / (to - from) : 0;
  };

  for (const [start, p] of starts) {
    if (start >= nFrames - 1) continue;
    let i = start + 1;
    let k = 0;
    while (i < nFrames - 1 && k < tol) {
      if (remaining[i * N_PITCHES + p] < thr) k++;
      else k = 0;
      i++;
    }
    i -= k;
    if (i - start <= opts.minNoteFrames) continue;
    for (let t = start; t < i; t++) clear(t, p);
    notes.push({ startFrame: start, endFrame: i, pitch: p + MIDI_OFFSET, amplitude: meanFrames(start, i, p) });
  }

  if (opts.melodiaTrick) {
    // Every cell above threshold is a candidate; since values only ever get zeroed, the
    // global maximum at any time is the first not-yet-cleared candidate in sorted order.
    const candidates: number[] = [];
    for (let i = 0; i < remaining.length; i++) if (remaining[i] > thr) candidates.push(i);
    candidates.sort((a, b) => remaining[b] - remaining[a]);
    for (const cell of candidates) {
      if (remaining[cell] <= thr) continue;
      const iMid = Math.floor(cell / N_PITCHES);
      const p = cell - iMid * N_PITCHES;
      remaining[cell] = 0;

      let i = iMid + 1;
      let k = 0;
      while (i < nFrames - 1 && k < tol) {
        if (remaining[i * N_PITCHES + p] < thr) k++;
        else k = 0;
        clear(i, p);
        i++;
      }
      const iEnd = i - 1 - k;

      i = iMid - 1;
      k = 0;
      while (i > 0 && k < tol) {
        if (remaining[i * N_PITCHES + p] < thr) k++;
        else k = 0;
        clear(i, p);
        i--;
      }
      const iStart = i + 1 + k;
      if (iEnd - iStart <= opts.minNoteFrames) continue;
      notes.push({ startFrame: iStart, endFrame: iEnd, pitch: p + MIDI_OFFSET, amplitude: meanFrames(iStart, iEnd, p) });
    }
  }

  notes.sort((a, b) => a.startFrame - b.startFrame || a.pitch - b.pitch);
  return notes;
}
