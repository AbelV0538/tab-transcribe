import { describe, expect, it } from 'vitest';
import { detectInstruments, pitchPrior } from '../src/music/instruments';
import { bassLine, guitarChords, guitarMelody, guitarRiff, note } from './helpers/notes';

describe('instrument detection', () => {
  it('detects a bass line alone', () => {
    const r = detectInstruments(bassLine(), 'auto');
    expect(r.bass.present).toBe(true);
    expect(r.guitar.present).toBe(false);
    expect(r.bassNotes).toHaveLength(16);
  });

  it('detects guitar chords alone', () => {
    const r = detectInstruments(guitarChords(), 'auto');
    expect(r.guitar.present).toBe(true);
    expect(r.bass.present).toBe(false);
  });

  it('treats a low single-note guitar riff as guitar', () => {
    const r = detectInstruments(guitarRiff(), 'auto');
    expect(r.guitar.present).toBe(true);
    expect(r.bass.present).toBe(false);
  });

  it('treats a guitar melody as guitar', () => {
    const r = detectInstruments(guitarMelody(), 'auto');
    expect(r.guitar.present).toBe(true);
    expect(r.bass.present).toBe(false);
  });

  it('separates bass and guitar playing together', () => {
    const bass = bassLine();
    const gtr = guitarChords();
    const r = detectInstruments([...bass, ...gtr], 'auto');
    expect(r.bass.present).toBe(true);
    expect(r.guitar.present).toBe(true);
    expect(r.bassNotes.map((n) => n.pitch).sort()).toEqual(bass.map((n) => n.pitch).sort());
    expect(r.guitarNotes).toHaveLength(gtr.length);
  });

  it('separates a bass line from a guitar melody', () => {
    const bass = bassLine();
    const r = detectInstruments([...bass, ...guitarMelody(0.1)], 'auto');
    expect(r.bass.present && r.guitar.present).toBe(true);
    expect(r.bassNotes).toHaveLength(bass.length);
  });

  it('removes overtone ghosts from a bass-only recording', () => {
    const bass = bassLine();
    const ghosts = bass.map((n) => note(n.pitch + 12, n.start + 0.01, 0.3, 0.3));
    const r = detectInstruments([...bass, ...ghosts], 'auto');
    expect(r.guitar.present).toBe(false);
    expect(r.bassNotes).toHaveLength(bass.length);
  });

  it('does not mistake drop-D power chords for bass', () => {
    const chords: ReturnType<typeof note>[] = [];
    for (let i = 0; i < 16; i++) {
      const root = [38, 38, 41, 43][i % 4];
      chords.push(note(root, i * 0.25, 0.2, 0.7, 0.2), note(root + 7, i * 0.25 + 0.005, 0.2, 0.65, 0.2), note(root + 12, i * 0.25 + 0.01, 0.2, 0.6, 0.2));
    }
    const r = detectInstruments(chords, 'auto');
    expect(r.guitar.present).toBe(true);
    expect(r.bass.present).toBe(false);
  });

  it('honours a forced mode', () => {
    const r = detectInstruments(guitarChords(), 'bass');
    expect(r.bass.present).toBe(true);
    expect(r.guitar.present).toBe(false);
    // Bass mode keeps a monophonic line: one note per chord.
    expect(r.bassNotes).toHaveLength(8);
    expect(r.bassNotes.every((n) => [40, 45, 50, 47].includes(n.pitch))).toBe(true);
  });

  it('pitch prior is monotonic in the overlap region', () => {
    for (let p = 30; p < 70; p++) expect(pitchPrior(p + 1)).toBeLessThanOrEqual(pitchPrior(p));
  });
});
