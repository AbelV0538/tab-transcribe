/**
 * Turns an instrument-agnostic analysis into per-instrument, playable tablature:
 * detect instruments → assign notes → clean up → choose tunings → optimise fingerings →
 * track beats → quantise → lay out bars.
 */
import type { AudioAnalysis, RawNote } from '../engine/types';
import { mergeFragments } from './cleanup';
import { assignFingerings, type FingeringOptions } from './fingering';
import { detectInstruments, type DetectionResult, type InstrumentMode } from './instruments';
import { correctWithHands, hintAt, type Playthrough } from './playthrough';
import { buildBeatGrid, slotsPerBar, timeToSlot, type BeatGrid, type OnsetHint } from './rhythm';
import { layoutBars, type TabBar } from './tab';
import { DEFAULT_FRETS, autoSelectTuning, findTuning, type InstrumentKind, type Tuning } from './tunings';

export interface InterpretSettings {
  instrumentMode: InstrumentMode;
  /** Tuning id or 'auto'. */
  guitarTuning: string;
  bassTuning: string;
  capo: number;
  /** Fixed tempo, or null to detect. */
  bpm: number | null;
  beatsPerBar: number;
  subdivision: 'auto' | 3 | 4;
}

export const DEFAULT_SETTINGS: InterpretSettings = {
  instrumentMode: 'auto',
  guitarTuning: 'auto',
  bassTuning: 'auto',
  capo: 0,
  bpm: null,
  beatsPerBar: 4,
  subdivision: 'auto',
};

export interface TrackNote {
  /** Pitch as placed on the fretboard. */
  pitch: number;
  /** Pitch as detected (differs only when octave-folded into range). */
  detectedPitch: number;
  start: number;
  end: number;
  amplitude: number;
  string: number;
  fret: number;
  folded: boolean;
  slot: number;
  endSlot: number;
}

export interface Track {
  instrument: InstrumentKind;
  tuning: Tuning;
  tuningWasAuto: boolean;
  capo: number;
  frets: number;
  notes: TrackNote[];
  bars: TabBar[];
  confidence: number;
  droppedNotes: number;
}

export interface Transcription {
  duration: number;
  tracks: Track[];
  grid: BeatGrid;
  detection: Pick<DetectionResult, 'guitar' | 'bass' | 'discarded'>;
  tuningCents: number | null;
  settings: InterpretSettings;
  /** Present when a playthrough video was used. */
  video?: VideoSummary;
}

export interface VideoSummary {
  instrument: InstrumentKind;
  /** Notes of the filmed instrument's track, and how many had a hand position to check. */
  notes: number;
  notesWithHand: number;
  /** Notes moved by an octave to fit the hand position. */
  octaveFixes: number;
}

/** Monophonic clean-up for bass: each note ends when the next begins. */
function makeMonophonic(notes: RawNote[]): RawNote[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const out: RawNote[] = [];
  sorted.forEach((n, i) => {
    const next = sorted[i + 1];
    const end = next && next.start < n.end ? next.start : n.end;
    if (end - n.start >= 0.03) out.push({ ...n, end });
  });
  return out;
}

/** Remove very short, weak blips that are almost always artefacts. */
function removeBlips(notes: RawNote[]): RawNote[] {
  if (notes.length === 0) return notes;
  const amps = notes.map((n) => n.amplitude).sort((a, b) => a - b);
  const med = amps[amps.length >> 1];
  return notes.filter((n) => !(n.end - n.start < 0.07 && n.amplitude < 0.6 * med));
}

function buildTrack(
  instrument: InstrumentKind,
  notes: RawNote[],
  tuningId: string,
  capo: number,
  confidence: number,
  grid: BeatGrid,
  hand?: FingeringOptions['hand'],
  fixedTuning?: Tuning,
): Track {
  const frets = DEFAULT_FRETS[instrument];
  const tuningWasAuto = tuningId === 'auto' || !findTuning(instrument, tuningId);
  const tuning = fixedTuning ?? (tuningWasAuto ? autoSelectTuning(instrument, notes.map((n) => n.pitch), frets) : (findTuning(instrument, tuningId) as Tuning));
  const effCapo = instrument === 'guitar' ? Math.max(0, Math.min(12, capo)) : 0;
  const { notes: fingered, dropped } = assignFingerings(notes, { tuning, instrument, frets, capo: effCapo, hand });
  const trackNotes: TrackNote[] = fingered
    .map((f) => {
      const slot = timeToSlot(grid, f.note.start);
      return {
        pitch: f.pitch,
        detectedPitch: f.note.pitch,
        start: f.note.start,
        end: f.note.end,
        amplitude: f.note.amplitude,
        string: f.string,
        fret: f.fret,
        folded: f.folded,
        slot,
        endSlot: Math.max(slot + 1, timeToSlot(grid, f.note.end)),
      };
    })
    .sort((a, b) => a.start - b.start || a.string - b.string);
  const bars = layoutBars(trackNotes, slotsPerBar(grid));
  return { instrument, tuning, tuningWasAuto, capo: effCapo, frets, notes: trackNotes, bars, confidence, droppedNotes: dropped.length };
}

/** Tuning for `instrument`: the chosen one, or auto-selected from the notes in its register. */
function resolveTuning(instrument: InstrumentKind, tuningId: string, notes: RawNote[]): Tuning {
  const fixed = tuningId !== 'auto' ? findTuning(instrument, tuningId) : undefined;
  if (fixed) return fixed;
  const inRange = notes.filter((n) => (instrument === 'bass' ? n.pitch <= 55 : n.pitch >= 35)).map((n) => n.pitch);
  return autoSelectTuning(instrument, inRange, DEFAULT_FRETS[instrument]);
}

export function interpret(analysis: AudioAnalysis, settings: InterpretSettings, playthrough?: Playthrough): Transcription {
  let notes = mergeFragments(analysis.notes);
  let filmed: { instrument: InstrumentKind; weights: number[] } | undefined;
  let filmedTuning: Tuning | undefined;
  let octaveFixes = 0;
  if (playthrough) {
    const inst = playthrough.instrument;
    filmedTuning = resolveTuning(inst, inst === 'guitar' ? settings.guitarTuning : settings.bassTuning, notes);
    const capo = inst === 'guitar' ? settings.capo : 0;
    const corrected = correctWithHands(notes, playthrough, filmedTuning, capo, DEFAULT_FRETS[inst]);
    octaveFixes = corrected.octaveFixes;
    // Octave fixes can land a ghost on its real note: merge those again, keeping weights aligned.
    const merged = mergeFragments(corrected.notes);
    const weightOf = new Map(corrected.notes.map((n, i) => [n, corrected.weights[i]]));
    notes = merged;
    filmed = { instrument: inst, weights: merged.map((n) => weightOf.get(n) ?? 1) };
  }

  let detection = detectInstruments(notes, settings.instrumentMode, filmed);
  if (playthrough && settings.instrumentMode === 'auto' && !detection[playthrough.instrument].present) {
    // The filmed instrument is certainly playing, even if the audio alone was unconvincing.
    const other = playthrough.instrument === 'bass' ? 'guitar' : 'bass';
    detection = detectInstruments(notes, detection[other].present ? 'both' : playthrough.instrument, filmed);
  }
  const bassNotes = removeBlips(makeMonophonic(detection.bassNotes));
  const guitarNotes = removeBlips(detection.guitarNotes);

  const hints: OnsetHint[] = [...bassNotes, ...guitarNotes].map((n) => ({ time: n.start, weight: n.amplitude, pitch: n.pitch }));
  const grid = buildBeatGrid(analysis.onsetEnvelope, analysis.envelopeRate, hints, {
    duration: analysis.duration,
    bpm: settings.bpm,
    beatsPerBar: settings.beatsPerBar,
    subdivision: settings.subdivision,
  });

  const hand = playthrough ? (t: number) => hintAt(playthrough.hints, t) : undefined;
  const isFilmed = (i: InstrumentKind) => playthrough?.instrument === i;
  const tracks: Track[] = [];
  if (detection.guitar.present) {
    tracks.push(
      buildTrack('guitar', guitarNotes, settings.guitarTuning, settings.capo, detection.guitar.confidence, grid, isFilmed('guitar') ? hand : undefined, isFilmed('guitar') ? filmedTuning : undefined),
    );
  }
  if (detection.bass.present) {
    tracks.push(buildTrack('bass', bassNotes, settings.bassTuning, 0, detection.bass.confidence, grid, isFilmed('bass') ? hand : undefined, isFilmed('bass') ? filmedTuning : undefined));
  }
  // Make every track show the same number of bars so they line up.
  const nBars = Math.max(1, ...tracks.map((t) => t.bars.length));
  for (const t of tracks) if (t.bars.length < nBars) t.bars = layoutBars(t.notes, slotsPerBar(grid), nBars);

  let video: VideoSummary | undefined;
  if (playthrough) {
    const track = tracks.find((t) => t.instrument === playthrough.instrument);
    const trackNotes = track?.notes ?? [];
    video = {
      instrument: playthrough.instrument,
      notes: trackNotes.length,
      notesWithHand: trackNotes.filter((n) => hintAt(playthrough.hints, n.start)).length,
      octaveFixes,
    };
  }

  return {
    duration: analysis.duration,
    tracks,
    grid,
    detection: { guitar: detection.guitar, bass: detection.bass, discarded: detection.discarded },
    tuningCents: analysis.tuningCents,
    settings,
    video,
  };
}
