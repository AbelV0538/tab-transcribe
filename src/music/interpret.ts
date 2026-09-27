/**
 * Turns an instrument-agnostic analysis into per-instrument, playable tablature:
 * detect instruments → assign notes → clean up → choose tunings → optimise fingerings →
 * track beats → quantise → lay out bars.
 */
import type { AudioAnalysis, RawNote } from '../engine/types';
import { mergeFragments } from './cleanup';
import { assignFingerings } from './fingering';
import { detectInstruments, type DetectionResult, type InstrumentMode } from './instruments';
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
): Track {
  const frets = DEFAULT_FRETS[instrument];
  const tuningWasAuto = tuningId === 'auto' || !findTuning(instrument, tuningId);
  const tuning = tuningWasAuto
    ? autoSelectTuning(instrument, notes.map((n) => n.pitch), frets)
    : (findTuning(instrument, tuningId) as Tuning);
  const effCapo = instrument === 'guitar' ? Math.max(0, Math.min(12, capo)) : 0;
  const { notes: fingered, dropped } = assignFingerings(notes, { tuning, instrument, frets, capo: effCapo });
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

export function interpret(analysis: AudioAnalysis, settings: InterpretSettings): Transcription {
  const detection = detectInstruments(mergeFragments(analysis.notes), settings.instrumentMode);
  const bassNotes = removeBlips(makeMonophonic(detection.bassNotes));
  const guitarNotes = removeBlips(detection.guitarNotes);

  const hints: OnsetHint[] = [...bassNotes, ...guitarNotes].map((n) => ({ time: n.start, weight: n.amplitude, pitch: n.pitch }));
  const grid = buildBeatGrid(analysis.onsetEnvelope, analysis.envelopeRate, hints, {
    duration: analysis.duration,
    bpm: settings.bpm,
    beatsPerBar: settings.beatsPerBar,
    subdivision: settings.subdivision,
  });

  const tracks: Track[] = [];
  if (detection.guitar.present) {
    tracks.push(buildTrack('guitar', guitarNotes, settings.guitarTuning, settings.capo, detection.guitar.confidence, grid));
  }
  if (detection.bass.present) {
    tracks.push(buildTrack('bass', bassNotes, settings.bassTuning, 0, detection.bass.confidence, grid));
  }
  // Make every track show the same number of bars so they line up.
  const nBars = Math.max(1, ...tracks.map((t) => t.bars.length));
  for (const t of tracks) if (t.bars.length < nBars) t.bars = layoutBars(t.notes, slotsPerBar(grid), nBars);

  return {
    duration: analysis.duration,
    tracks,
    grid,
    detection: { guitar: detection.guitar, bass: detection.bass, discarded: detection.discarded },
    tuningCents: analysis.tuningCents,
    settings,
  };
}
