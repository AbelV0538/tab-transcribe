/**
 * Oracle fingering benchmark: feed the tab's own notes (pitch and timing) to the fingering
 * optimiser with the tab's tuning, and compare the chosen strings/frets with the tab's.
 * No audio is involved, so this isolates how human-like (and playable) the fingering is.
 */
import { assignFingerings, type FingeringOptions, type NoteIn } from '../../src/music/fingering';
import type { Tuning } from '../../src/music/tunings';
import type { AlbumSong } from './dataset';
import { loadTabs } from './dataset';
import type { GpTrack, GtNote } from './gp';
import { playability, sumPlayability, type Placed, type PlayabilityStats } from './metrics';

export interface OracleNote extends NoteIn {
  gt: GtNote;
}

export interface ErrorBreakdown {
  /** Tab plays an open string, the optimiser frets the pitch. */
  openToFretted: number;
  /** Tab frets the pitch, the optimiser uses an open string. */
  frettedToOpen: number;
  /** Both fretted, on strings this many apart (index 1..). */
  stringsApart: number[];
  dropped: number;
}

export interface TrackResult {
  song: string;
  track: string;
  notes: number;
  /** Notes scored (excludes tapped notes). */
  scored: number;
  correct: number;
  tapped: number;
  tappedCorrect: number;
  errors: ErrorBreakdown;
  tab: PlayabilityStats;
  model: PlayabilityStats;
}

export function trackTuning(t: GpTrack): Tuning {
  return { id: 'tab', name: 'tab', instrument: 'guitar', strings: t.tuning, popularity: 1, auto: false };
}

/** The tab's notes as optimiser input. Harmonics are left out: their fret doesn't give their pitch. */
export function oracleInput(t: GpTrack): OracleNote[] {
  return t.notes.filter((n) => !n.harmonic).map((n) => ({ pitch: n.fretPitch, start: n.start, end: n.end, amplitude: 0.8, gt: n }));
}

export function runTrack(song: string, t: GpTrack, extra: Partial<FingeringOptions> = {}): TrackResult {
  const input = oracleInput(t);
  const opts: FingeringOptions = { tuning: trackTuning(t), instrument: 'guitar', frets: Math.max(t.frets, 22), capo: t.capo, ...extra };
  const { notes: placed } = assignFingerings(input, opts);
  const byNote = new Map(placed.map((p) => [p.note, p]));
  const errors: ErrorBreakdown = { openToFretted: 0, frettedToOpen: 0, stringsApart: [], dropped: 0 };
  let scored = 0;
  let correct = 0;
  let tapped = 0;
  let tappedCorrect = 0;
  for (const n of input) {
    const p = byNote.get(n);
    const ok = !!p && p.string === n.gt.string && p.fret === n.gt.fret;
    if (n.gt.tapped || n.gt.leftHandTapped) {
      tapped++;
      if (ok) tappedCorrect++;
      continue;
    }
    scored++;
    if (ok) {
      correct++;
      continue;
    }
    if (!p) errors.dropped++;
    else if (n.gt.fret === 0 && p.fret > 0) errors.openToFretted++;
    else if (n.gt.fret > 0 && p.fret === 0) errors.frettedToOpen++;
    else {
      const d = Math.abs(p.string - n.gt.string);
      errors.stringsApart[d] = (errors.stringsApart[d] ?? 0) + 1;
    }
  }
  const tabPlaced: Placed[] = input.map((n) => ({ pitch: n.pitch, string: n.gt.string, fret: n.gt.fret, start: n.start, end: n.end }));
  const modelPlaced: Placed[] = placed.map((p) => ({ pitch: p.pitch, string: p.string, fret: p.fret, start: p.note.start, end: p.note.end }));
  return {
    song,
    track: t.name,
    notes: input.length,
    scored,
    correct,
    tapped,
    tappedCorrect,
    errors,
    tab: playability(tabPlaced),
    model: playability(modelPlaced),
  };
}

export function runSong(song: AlbumSong, extra: Partial<FingeringOptions> = {}): TrackResult[] {
  const tabs = loadTabs(song);
  return tabs.tracks.filter((t) => t.notes.length > 0).map((t) => runTrack(song.title, t, extra));
}

export interface Summary {
  notes: number;
  scored: number;
  /** Exact string+fret accuracy over scored notes (the pitch is given, so the string decides the fret). */
  accuracy: number;
  /** Mean of per-song accuracies (each song counts equally). */
  songAccuracy: number;
  tappedAccuracy: number;
  errors: ErrorBreakdown;
  tab: PlayabilityStats;
  model: PlayabilityStats;
}

export function summarise(results: TrackResult[]): Summary {
  const sum = (f: (r: TrackResult) => number) => results.reduce((s, r) => s + f(r), 0);
  const songs = new Map<string, { scored: number; correct: number }>();
  for (const r of results) {
    const s = songs.get(r.song) ?? { scored: 0, correct: 0 };
    s.scored += r.scored;
    s.correct += r.correct;
    songs.set(r.song, s);
  }
  const songAcc = [...songs.values()].map((s) => s.correct / Math.max(1, s.scored));
  const errors: ErrorBreakdown = { openToFretted: sum((r) => r.errors.openToFretted), frettedToOpen: sum((r) => r.errors.frettedToOpen), stringsApart: [], dropped: sum((r) => r.errors.dropped) };
  for (const r of results) r.errors.stringsApart.forEach((v, d) => (errors.stringsApart[d] = (errors.stringsApart[d] ?? 0) + (v ?? 0)));
  return {
    notes: sum((r) => r.notes),
    scored: sum((r) => r.scored),
    accuracy: sum((r) => r.correct) / Math.max(1, sum((r) => r.scored)),
    songAccuracy: songAcc.reduce((a, b) => a + b, 0) / Math.max(1, songAcc.length),
    tappedAccuracy: sum((r) => r.tappedCorrect) / Math.max(1, sum((r) => r.tapped)),
    errors,
    tab: sumPlayability(results.map((r) => r.tab)),
    model: sumPlayability(results.map((r) => r.model)),
  };
}
