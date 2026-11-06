/**
 * Instrument separation on synthesised recordings: HTDemucs → note model per stem → tabs,
 * compared with transcribing the mix. Run with `npm run test:model`; skipped without the
 * separation model (`npm run models:separation`).
 *
 * The plucked-string synth is not a real guitar or bass, so the stems are less clean than on
 * real recordings: these tests check robustness (no phantom instruments, no lost bass line)
 * rather than the accuracy gain, which the album benchmark measures.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { halveRate } from '../src/audio/resample';
import type { AudioAnalysis } from '../src/engine/types';
import { DEFAULT_SETTINGS, interpret, type Transcription } from '../src/music/interpret';
import { SEPARATION_RATE } from '../src/separation/demucs';
import { instrumentStems } from '../src/separation/stems';
import { getAnalyzer } from './helpers/model';
import { hasSeparationModel, separateInNode } from './helpers/separation';
import { bassSong, guitarChordSong, guitarMelodySong, synthesize, type SynthNote } from './helpers/synth';

const DURATION = 9;
const report: string[] = ['# Instrument separation on synthesised recordings', ''];

interface Result {
  mix: Transcription;
  separated: Transcription;
  analysis: AudioAnalysis;
}

function recall(ref: SynthNote[], got: Array<{ pitch: number; start: number }>): number {
  const used = new Set<number>();
  let hits = 0;
  for (const r of ref) {
    const i = got.findIndex((g, k) => !used.has(k) && g.pitch === r.pitch && Math.abs(g.start - r.start) <= 0.05);
    if (i >= 0) {
      used.add(i);
      hits++;
    }
  }
  return ref.length ? hits / ref.length : 1;
}

const trackNotes = (t: Transcription, instrument: 'guitar' | 'bass') => t.tracks.find((x) => x.instrument === instrument)?.notes ?? [];

describe.skipIf(!hasSeparationModel())('instrument separation on synthesised recordings', () => {
  const songs = {
    bass: bassSong(4),
    chords: guitarChordSong(4),
    melody: guitarMelodySong(4),
    band: [...bassSong(4), ...guitarChordSong(4)],
    bassMelody: [...bassSong(4), ...guitarMelodySong(4)],
  };
  const results: Record<string, Result> = {};

  beforeAll(async () => {
    const analyzer = await getAnalyzer();
    for (const [name, notes] of Object.entries(songs)) {
      const audio44 = synthesize(notes, DURATION, SEPARATION_RATE);
      const mono = halveRate(audio44);
      const mixAnalysis = await analyzer.analyze(mono, 'normal');
      const mix = interpret(mixAnalysis, DEFAULT_SETTINGS);
      const stems = instrumentStems(await separateInNode(audio44, audio44));
      const analysis = await analyzer.analyze(mono, 'normal', undefined, stems);
      const separated = interpret(analysis, DEFAULT_SETTINGS);
      results[name] = { mix, separated, analysis };
      const line = (label: string, t: Transcription) =>
        `- ${label}: guitar ${t.detection.guitar.present ? `${trackNotes(t, 'guitar').length} notes` : 'absent'}, bass ${t.detection.bass.present ? `${trackNotes(t, 'bass').length} notes` : 'absent'}`;
      report.push(`## ${name}`, line('mix', mix), line('separated', separated));
      const bassRef = notes.filter((n) => n.instrument === 'bass');
      if (bassRef.length) report.push(`- bass recall: mix ${recall(bassRef, trackNotes(mix, 'bass')).toFixed(2)}, separated ${recall(bassRef, trackNotes(separated, 'bass')).toFixed(2)}`);
      report.push('');
    }
  }, 900_000);

  afterAll(() => {
    const out = path.resolve(__dirname, 'e2e/out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'separation-model.md'), report.join('\n') + '\n');
  });

  it('tags every note with the stem it was heard in', () => {
    for (const r of Object.values(results)) {
      expect(r.analysis.separated).toBe(true);
      expect(r.analysis.notes.every((n) => n.stem === 'guitar' || n.stem === 'bass')).toBe(true);
    }
  });

  it('keeps the bass line', () => {
    for (const name of ['bass', 'band', 'bassMelody'] as const) {
      const r = results[name];
      const ref = songs[name].filter((n) => n.instrument === 'bass');
      expect(r.separated.detection.bass.present, name).toBe(true);
      expect(recall(ref, trackNotes(r.separated, 'bass')), name).toBeGreaterThanOrEqual(Math.min(0.8, recall(ref, trackNotes(r.mix, 'bass')) - 0.1));
    }
  });

  it('does not invent a bass for guitar-only recordings', () => {
    for (const name of ['chords', 'melody'] as const) expect(results[name].separated.detection.bass.present, name).toBe(false);
  });

  it('does not invent a guitar for a bass-only recording', () => {
    expect(results.bass.separated.detection.guitar.present).toBe(false);
  });
});
