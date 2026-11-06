/** A song's recording, analysed and with the tab's notes aligned to it (shared by the audio benchmarks). */
import fs from 'node:fs';
import path from 'node:path';
import type { AudioAnalysis } from '../../src/engine/types';
import type { DetectionOptions } from '../../src/music/instruments';
import { interpret, type InterpretSettings } from '../../src/music/interpret';
import { GUITAR_TUNINGS } from '../../src/music/tunings';
import { align, type Alignment } from './align';
import { analyseRecording, type SeparationChoice } from './analysis';
import { loadTabs, type AlbumSong } from './dataset';
import type { GpSong } from './gp';
import { matchNotes, playability, type PlayabilityStats } from './metrics';

/** A tab note in recording time. */
export interface RefNote {
  pitch: number;
  start: number;
  end: number;
  string: number;
  fret: number;
  harmonic: string | null;
  tuning: number[];
}

export interface PreparedRecording {
  song: AlbumSong;
  tabs: GpSong;
  analysis: AudioAnalysis;
  alignment: Alignment;
  /** Every guitar track's notes, in recording time. */
  refs: RefNote[];
  /** The app's id for the tab's main guitar tuning, or null when the app doesn't have it. */
  tabTuningId: string | null;
}

const OFFSETS_FILE = path.resolve(__dirname, 'offsets.json');

export async function prepareRecording(song: AlbumSong): Promise<PreparedRecording> {
  if (!song.audioFile) throw new Error(`${song.title}: no recording`);
  const offsets: Record<string, number> = fs.existsSync(OFFSETS_FILE) ? JSON.parse(fs.readFileSync(OFFSETS_FILE, 'utf8')) : {};
  const tabs = loadTabs(song);
  const analysis = await analyseRecording(song.audioFile);
  const tabNotes = tabs.tracks.flatMap((t) => t.notes.map((n) => ({ pitch: n.pitch, start: n.start, end: n.end, string: n.string, fret: n.fret, harmonic: n.harmonic, tuning: t.tuning })));
  const alignment = align(analysis.notes, tabNotes, tabs.barTimes, offsets[song.title]);
  const refs = tabNotes.map((n) => ({ ...n, start: alignment.map(n.start), end: alignment.map(n.end) }));
  const main = [...tabs.tracks].sort((a, b) => b.notes.length - a.notes.length)[0];
  const tabTuningId = GUITAR_TUNINGS.find((t) => t.strings.join() === main.tuning.join())?.id ?? null;
  return { song, tabs, analysis, alignment, refs, tabTuningId };
}

/**
 * The same recording analysed from its separated stems. The tab alignment of the mix is kept,
 * so every configuration is scored against the same reference timing.
 */
export async function withSeparation(rec: PreparedRecording, separation: SeparationChoice): Promise<PreparedRecording> {
  return { ...rec, analysis: await analyseRecording(rec.song.audioFile!, 'normal', separation) };
}

export interface AudioResult {
  song: string;
  config: string;
  alignment: number;
  raw: { precision: number; recall: number; f1: number };
  guitar: { notes: number; precision: number; recall: number; f1: number; octaveFreeF1: number };
  /** Matched notes placed on the tab's string and fret (only when the tunings agree). */
  fretAgreement: number | null;
  dropped: number;
  play: PlayabilityStats;
  tabBpm: number;
  bpm: number;
  tuning: string;
}

/** Transcribe a prepared recording with `settings` and score the guitar track. */
export function scoreGuitar(rec: PreparedRecording, settings: InterpretSettings, config: string, detection?: DetectionOptions): AudioResult {
  const t = interpret(rec.analysis, settings, undefined, detection);
  const g = t.tracks.find((x) => x.instrument === 'guitar');
  const notes = g?.notes ?? [];
  const m = matchNotes(rec.refs, notes);
  const raw = matchNotes(rec.refs, rec.analysis.notes);
  let fretAgreement: number | null = null;
  if (g) {
    const comparable = m.pairs.filter(([r]) => r.tuning.join() === g.tuning.strings.join() && !r.harmonic);
    if (comparable.length >= 20) fretAgreement = comparable.filter(([r, n]) => r.string === n.string && r.fret === n.fret).length / comparable.length;
  }
  return {
    song: rec.song.title,
    config,
    alignment: rec.alignment.matchRate,
    raw: { precision: raw.precision, recall: raw.recall, f1: raw.f1 },
    guitar: { notes: notes.length, precision: m.precision, recall: m.recall, f1: m.f1, octaveFreeF1: matchNotes(rec.refs, notes, 0.05, true).f1 },
    fretAgreement,
    dropped: g?.droppedNotes ?? 0,
    play: playability(notes),
    tabBpm: rec.tabs.tempo[0].qpm / rec.alignment.scale,
    bpm: t.grid.bpm,
    tuning: g?.tuning.name ?? '–',
  };
}
