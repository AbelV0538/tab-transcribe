import { pitchClassName } from './theory';

export type InstrumentKind = 'guitar' | 'bass';

export interface Tuning {
  id: string;
  name: string;
  instrument: InstrumentKind;
  /** Open-string MIDI pitches from the lowest (thickest) string to the highest. */
  strings: number[];
  /** Rough prior of how common the tuning is; used when auto-selecting. */
  popularity: number;
  /** Whether auto-selection may pick this tuning from pitch content alone. */
  auto: boolean;
}

export const GUITAR_TUNINGS: Tuning[] = [
  { id: 'standard', name: 'Standard (E A D G B E)', instrument: 'guitar', strings: [40, 45, 50, 55, 59, 64], popularity: 1, auto: true },
  { id: 'dropD', name: 'Drop D (D A D G B E)', instrument: 'guitar', strings: [38, 45, 50, 55, 59, 64], popularity: 0.35, auto: true },
  { id: 'eb', name: 'E♭ standard (half step down)', instrument: 'guitar', strings: [39, 44, 49, 54, 58, 63], popularity: 0.3, auto: true },
  { id: 'dStandard', name: 'D standard (whole step down)', instrument: 'guitar', strings: [38, 43, 48, 53, 57, 62], popularity: 0.15, auto: true },
  { id: 'dropC', name: 'Drop C (C G C F A D)', instrument: 'guitar', strings: [36, 43, 48, 53, 57, 62], popularity: 0.12, auto: true },
  { id: 'sevenString', name: '7-string standard (B E A D G B E)', instrument: 'guitar', strings: [35, 40, 45, 50, 55, 59, 64], popularity: 0.08, auto: true },
  { id: 'dadgad', name: 'DADGAD', instrument: 'guitar', strings: [38, 45, 50, 55, 57, 62], popularity: 0.05, auto: false },
  { id: 'openG', name: 'Open G (D G D G B D)', instrument: 'guitar', strings: [38, 43, 50, 55, 59, 62], popularity: 0.05, auto: false },
  { id: 'openD', name: 'Open D (D A D F# A D)', instrument: 'guitar', strings: [38, 45, 50, 54, 57, 62], popularity: 0.04, auto: false },
  { id: 'openE', name: 'Open E (E B E G# B E)', instrument: 'guitar', strings: [40, 47, 52, 56, 59, 64], popularity: 0.03, auto: false },
];

export const BASS_TUNINGS: Tuning[] = [
  { id: 'standard', name: 'Standard 4-string (E A D G)', instrument: 'bass', strings: [28, 33, 38, 43], popularity: 1, auto: true },
  { id: 'fiveString', name: 'Standard 5-string (B E A D G)', instrument: 'bass', strings: [23, 28, 33, 38, 43], popularity: 0.3, auto: true },
  { id: 'dropD', name: 'Drop D (D A D G)', instrument: 'bass', strings: [26, 33, 38, 43], popularity: 0.2, auto: true },
  { id: 'eb', name: 'E♭ standard (half step down)', instrument: 'bass', strings: [27, 32, 37, 42], popularity: 0.15, auto: true },
  { id: 'dStandard', name: 'D standard (D G C F)', instrument: 'bass', strings: [26, 31, 36, 41], popularity: 0.06, auto: true },
  { id: 'sixString', name: '6-string (B E A D G C)', instrument: 'bass', strings: [23, 28, 33, 38, 43, 48], popularity: 0.05, auto: false },
];

export const DEFAULT_FRETS: Record<InstrumentKind, number> = { guitar: 22, bass: 21 };

/** Default tuning choice: standard tuning, with the number of strings decided from the notes. */
export const STANDARD_ANY_STRINGS = 'standard-auto';
/** Tuning choice that lets the app guess any tuning (drop D, E♭, …) from the notes. */
export const ANY_TUNING = 'auto';

export function tuningsFor(instrument: InstrumentKind): Tuning[] {
  return instrument === 'guitar' ? GUITAR_TUNINGS : BASS_TUNINGS;
}

export function findTuning(instrument: InstrumentKind, id: string): Tuning | undefined {
  return tuningsFor(instrument).find((t) => t.id === id);
}

/** Labels for each string, lowest first. The top string is lower-case when it repeats the bottom's name ("e"). */
export function stringLabels(tuning: Tuning): string[] {
  const names = tuning.strings.map((p) => pitchClassName(p, true));
  const last = names.length - 1;
  if (names[last] === names[0]) names[last] = names[last].toLowerCase();
  return names;
}

/**
 * Standard tuning for an instrument, with the extra low string (5-string bass B, 7-string guitar
 * B) when the notes go below the usual lowest string: a couple of notes, at least 1% of them,
 * that only the extra string can play.
 */
export function standardTuning(instrument: InstrumentKind, pitches: number[]): Tuning {
  const [usual, extended] = instrument === 'bass' ? ['standard', 'fiveString'] : ['standard', 'sevenString'];
  const normal = findTuning(instrument, usual)!;
  const extra = findTuning(instrument, extended)!;
  const below = pitches.filter((p) => p < normal.strings[0] && p >= extra.strings[0]).length;
  return below >= 2 && below >= 0.01 * pitches.length ? extra : normal;
}

/** The tuning for a setting value (a tuning id, STANDARD_ANY_STRINGS or ANY_TUNING). */
export function resolveTuning(instrument: InstrumentKind, choice: string, pitches: number[], frets = DEFAULT_FRETS[instrument]): { tuning: Tuning; automatic: boolean } {
  if (choice === ANY_TUNING) return { tuning: autoSelectTuning(instrument, pitches, frets), automatic: true };
  const fixed = findTuning(instrument, choice);
  if (fixed) return { tuning: fixed, automatic: false };
  return { tuning: standardTuning(instrument, pitches), automatic: true };
}

/**
 * Pick the most plausible tuning for a set of note pitches: prefer common tunings, require
 * the notes to fit on the fretboard, and favour a tuning whose lowest open string is the
 * lowest note played (players tend to use the open low string).
 */
export function autoSelectTuning(instrument: InstrumentKind, pitches: number[], frets = DEFAULT_FRETS[instrument]): Tuning {
  const candidates = tuningsFor(instrument).filter((t) => t.auto);
  if (pitches.length === 0) return candidates[0];
  const count = (p: number) => pitches.filter((x) => x === p).length;
  // A tuning's open low string is "used" if it is played more than once (or is a real share
  // of the notes); a single stray low detection should not switch the tuning.
  const used = (p: number) => Math.min(1, count(p) / Math.max(2, 0.03 * pitches.length));
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const t of candidates) {
    const low = t.strings[0];
    const high = t.strings[t.strings.length - 1] + frets;
    const outOfRange = pitches.filter((p) => p < low || p > high).length / pitches.length;
    let score = Math.log(t.popularity) - 12 * outOfRange + used(low);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}
