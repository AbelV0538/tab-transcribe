/**
 * End-to-end: synthesised recordings → real neural model → instrument detection → tabs.
 * Run with `npm run test:model`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AudioAnalysis } from '../src/engine/types';
import { DEFAULT_SETTINGS, interpret, type Track, type Transcription } from '../src/music/interpret';
import { renderAsciiTab } from '../src/music/tab';
import { getAnalyzer } from './helpers/model';
import { bassSong, guitarChordSong, guitarMelodySong, synthesize, type SynthNote } from './helpers/synth';

const SR = 22050;
const report: string[] = [];

async function analyse(notes: SynthNote[], duration: number): Promise<AudioAnalysis> {
  const analyzer = await getAnalyzer();
  return analyzer.analyze(synthesize(notes, duration, SR), 'normal');
}

/** Onset/pitch matching: a detected note matches a reference note within 50 ms and same pitch. */
function score(ref: SynthNote[], got: Array<{ pitch: number; start: number }>) {
  const used = new Set<number>();
  const errors: number[] = [];
  let hits = 0;
  for (const r of ref) {
    let best = -1;
    got.forEach((g, i) => {
      if (used.has(i) || g.pitch !== r.pitch) return;
      if (Math.abs(g.start - r.start) <= 0.05 && (best < 0 || Math.abs(g.start - r.start) < Math.abs(got[best].start - r.start))) best = i;
    });
    if (best >= 0) {
      used.add(best);
      hits++;
      errors.push(got[best].start - r.start);
    }
  }
  errors.sort((a, b) => a - b);
  return {
    recall: hits / ref.length,
    precision: got.length ? hits / got.length : 0,
    medianError: errors.length ? errors[errors.length >> 1] : NaN,
  };
}

function track(t: Transcription, instrument: 'guitar' | 'bass'): Track | undefined {
  return t.tracks.find((x) => x.instrument === instrument);
}

function log(title: string, t: Transcription) {
  report.push(`## ${title}`);
  report.push(`bpm=${t.grid.bpm} subdivision=${t.grid.subdivision} guitar=${JSON.stringify(t.detection.guitar)} bass=${JSON.stringify(t.detection.bass)}`);
  for (const tr of t.tracks) {
    report.push(`### ${tr.instrument} (${tr.tuning.name}) notes=${tr.notes.length}`);
    report.push(renderAsciiTab(tr.bars, tr.tuning, { barsPerLine: 2 }));
  }
}

describe('full pipeline on synthesised recordings', () => {
  const songs = {
    bass: bassSong(4),
    chords: guitarChordSong(4),
    melody: guitarMelodySong(4),
  };
  const results: Record<string, { analysis: AudioAnalysis; t: Transcription }> = {};

  beforeAll(async () => {
    const duration = 9;
    for (const [name, notes] of Object.entries({
      bass: songs.bass,
      chords: songs.chords,
      melody: songs.melody,
      band: [...songs.bass, ...songs.chords],
      bassMelody: [...songs.bass, ...songs.melody],
    })) {
      const analysis = await analyse(notes, duration);
      const t = interpret(analysis, DEFAULT_SETTINGS);
      results[name] = { analysis, t };
      log(name, t);
    }
  });

  it('transcribes a bass line and detects bass only', () => {
    const { analysis, t } = results.bass;
    const raw = score(songs.bass, analysis.notes);
    report.push(`bass raw: ${JSON.stringify(raw)}`);
    expect(Math.abs(raw.medianError)).toBeLessThan(0.02);
    expect(t.detection.bass.present).toBe(true);
    expect(t.detection.guitar.present).toBe(false);
    const s = score(songs.bass, track(t, 'bass')!.notes);
    report.push(`bass track: ${JSON.stringify(s)}`);
    expect(s.recall).toBeGreaterThan(0.9);
    expect(s.precision).toBeGreaterThan(0.9);
    expect(Math.abs(t.grid.bpm - 120)).toBeLessThanOrEqual(3);
    // Bar lines: the line starts on beat 1 and the first bass note sits on slot 0.
    expect(track(t, 'bass')!.notes[0].slot).toBe(0);
  });

  it('transcribes strummed chords and detects guitar only', () => {
    const { analysis, t } = results.chords;
    report.push(`chords raw: ${JSON.stringify(score(songs.chords, analysis.notes))}`);
    expect(t.detection.guitar.present).toBe(true);
    expect(t.detection.bass.present).toBe(false);
    const s = score(songs.chords, track(t, 'guitar')!.notes);
    report.push(`chords track: ${JSON.stringify(s)}`);
    expect(s.recall).toBeGreaterThan(0.7);
    expect(s.precision).toBeGreaterThan(0.7);
  });

  it('transcribes a guitar melody and detects guitar only', () => {
    const { t } = results.melody;
    expect(t.detection.guitar.present).toBe(true);
    expect(t.detection.bass.present).toBe(false);
    const s = score(songs.melody, track(t, 'guitar')!.notes);
    report.push(`melody track: ${JSON.stringify(s)}`);
    expect(s.recall).toBeGreaterThan(0.85);
    expect(s.precision).toBeGreaterThan(0.85);
    // Pentatonic melody: should stay within a compact area of the neck.
    const frets = track(t, 'guitar')!.notes.map((n) => n.fret).filter((f) => f > 0);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(5);
  });

  it('separates bass and guitar chords playing together', () => {
    const { t, analysis } = results.band;
    const raw = score(songs.chords, analysis.notes);
    report.push(`band raw guitar: ${JSON.stringify(raw)}`);
    expect(t.detection.bass.present).toBe(true);
    expect(t.detection.guitar.present).toBe(true);
    const b = score(songs.bass, track(t, 'bass')!.notes);
    const g = score(songs.chords, track(t, 'guitar')!.notes);
    report.push(`band bass: ${JSON.stringify(b)} guitar: ${JSON.stringify(g)}`);
    expect(b.recall).toBeGreaterThan(0.85);
    expect(b.precision).toBeGreaterThan(0.75);
    // The model itself misses some chord tones under a loud bass; assignment must keep what
    // it found and clean out most of the bass overtones.
    expect(g.recall).toBeGreaterThanOrEqual(raw.recall * 0.9);
    expect(g.precision).toBeGreaterThan(Math.max(0.5, raw.precision * 2));
  });

  it('separates bass and a guitar melody playing together', () => {
    const { t } = results.bassMelody;
    expect(t.detection.bass.present).toBe(true);
    expect(t.detection.guitar.present).toBe(true);
    const b = score(songs.bass, track(t, 'bass')!.notes);
    const g = score(songs.melody, track(t, 'guitar')!.notes);
    report.push(`bass+melody bass: ${JSON.stringify(b)} guitar: ${JSON.stringify(g)}`);
    expect(b.recall).toBeGreaterThan(0.75);
    expect(g.recall).toBeGreaterThan(0.75);
  });

  it('writes a report', () => {
    const out = path.resolve(__dirname, 'e2e/out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'model-report.md'), report.join('\n'));
  });
});
