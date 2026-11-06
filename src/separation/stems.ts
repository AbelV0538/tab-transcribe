/** Which separated stems are kept, and which of them are transcribed as guitar and as bass. */
import type { StemName } from './demucs';

/**
 * Stems transcribed as guitar. HTDemucs puts some guitar (especially clean and heavily
 * effected parts) into "other", but adding "other" brings in more wrong notes than right ones:
 * on the album benchmark, guitar F1 was 29.6 % with the guitar stem alone and 28.1 % with
 * guitar + other.
 */
export const GUITAR_STEMS: readonly StemName[] = ['guitar'];

/**
 * When the separator didn't recognise the guitar at all, it ends up in "other" or "piano". So
 * when the guitar stem holds less than this share of the energy of the guitar, other and piano
 * stems together, all three are transcribed as guitar instead.
 */
export const MIN_GUITAR_STEM_ENERGY = 0.1;
export const GUITAR_FALLBACK_STEMS: readonly StemName[] = ['guitar', 'other', 'piano'];

/** Stems kept from the separation (the rest, e.g. vocals and drums, are discarded). */
export const KEPT_STEMS: readonly StemName[] = [...new Set<StemName>([...GUITAR_STEMS, ...GUITAR_FALLBACK_STEMS, 'bass'])];

/** Mono audio at the note model's rate, one per instrument the app writes tabs for. */
export interface InstrumentStems {
  guitar: Float32Array;
  bass: Float32Array;
  /** The stems that make up `guitar`. */
  guitarFrom: readonly StemName[];
}

function sum(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)));
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

function energy(x: Float32Array | undefined): number {
  let e = 0;
  if (x) for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return e;
}

/** Which stems to transcribe as guitar (see `MIN_GUITAR_STEM_ENERGY`). */
export function chooseGuitarStems(stems: Partial<Record<StemName, Float32Array>>): readonly StemName[] {
  const inGuitar = GUITAR_STEMS.reduce((e, s) => e + energy(stems[s]), 0);
  const candidates = GUITAR_FALLBACK_STEMS.reduce((e, s) => e + energy(stems[s]), 0);
  return candidates > 0 && inGuitar < MIN_GUITAR_STEM_ENERGY * candidates ? GUITAR_FALLBACK_STEMS : GUITAR_STEMS;
}

/** The guitar and bass audio to transcribe. `guitarStems` overrides the automatic choice. */
export function instrumentStems(stems: Partial<Record<StemName, Float32Array>>, guitarStems?: readonly StemName[]): InstrumentStems {
  const pick = (name: StemName) => {
    const s = stems[name];
    if (!s) throw new Error(`Stem "${name}" was not separated`);
    return s;
  };
  const guitarFrom = guitarStems ?? chooseGuitarStems(stems);
  return { guitar: sum(guitarFrom.map(pick)), bass: pick('bass'), guitarFrom };
}
