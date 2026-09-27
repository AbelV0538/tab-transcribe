/** Generic clean-up of raw note detections before instrument assignment. */
import type { RawNote } from '../engine/types';

/**
 * The note model sometimes reports one plucked note as two overlapping detections of the
 * same pitch a few tens of milliseconds apart (a weak early fragment plus the main note).
 * Merge them, keeping the onset and features of the stronger detection.
 */
export function mergeFragments(notes: RawNote[], window = 0.08): RawNote[] {
  const sorted = [...notes].sort((a, b) => a.pitch - b.pitch || a.start - b.start);
  const out: RawNote[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    const touching = last && last.pitch === n.pitch && n.start <= last.end + 0.03;
    // An earlier fragment without a pluck of its own, right before a clearly plucked note.
    const unplucked = touching && n.start - last.start <= 0.16 && last.features.onsetStrength < 0.6 && n.features.onsetStrength > 0.85;
    if (touching && (n.start - last.start <= window || unplucked)) {
      const strength = (x: RawNote) => x.amplitude * Math.min(0.3, x.end - x.start);
      const main = strength(n) > strength(last) ? n : last;
      out[out.length - 1] = { ...main, end: Math.max(last.end, n.end), amplitude: Math.max(last.amplitude, n.amplitude) };
    } else out.push(n);
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}
