import { describe, expect, it } from 'vitest';
import type { NoteStem, RawNote } from '../src/engine/types';
import { mergeFragments } from '../src/music/cleanup';
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

describe('instrument detection with separated stems', () => {
  const tag = (notes: RawNote[], stem: NoteStem) => notes.map((n) => ({ ...n, stem }));

  it('trusts the bass stem for a bass line in the guitar register', () => {
    // A bass line around A2-E3, where the register alone suggests guitar.
    const pattern = [45, 47, 48, 50, 52, 50, 48, 47];
    const bass = Array.from({ length: 16 }, (_, i) => note(pattern[i % 8], i * 0.5, 0.45, 0.7, 0.5));
    const gtr = guitarChords();
    const untagged = detectInstruments([...bass, ...gtr], 'auto');
    expect(untagged.bassNotes.length).toBeLessThan(bass.length);

    const r = detectInstruments([...tag(bass, 'bass'), ...tag(gtr, 'guitar')], 'auto');
    expect(r.bass.present).toBe(true);
    expect(r.guitar.present).toBe(true);
    expect(r.bassNotes.map((n) => n.pitch)).toEqual(bass.map((n) => n.pitch));
    expect(r.guitarNotes).toHaveLength(gtr.length);
  });

  it('keeps a guitar note an octave above the bass (not an overtone when it is in another stem)', () => {
    const bass = Array.from({ length: 16 }, (_, i) => note([40, 43, 45, 38][i % 4], i * 0.5, 0.45, 0.8, 0.7));
    const octaves = bass.map((n) => note(n.pitch + 12, n.start + 0.005, 0.3, 0.5, 0.3));
    // From the mix alone these look exactly like overtones of the bass.
    const untagged = detectInstruments([...bass, ...octaves], 'auto');
    expect(untagged.guitarNotes).toHaveLength(0);

    const r = detectInstruments([...tag(bass, 'bass'), ...tag(octaves, 'guitar')], 'auto');
    expect(r.guitar.present).toBe(true);
    expect(r.guitarNotes.map((n) => n.pitch)).toEqual(octaves.map((n) => n.pitch));
    expect(r.bassNotes).toHaveLength(bass.length);
  });

  it('still treats a weak octave in the same stem as an overtone', () => {
    const bass = tag(bassLine(), 'bass');
    const ghosts = tag(
      bass.map((n) => note(n.pitch + 12, n.start + 0.01, 0.3, 0.3)),
      'bass',
    );
    const r = detectInstruments([...bass, ...ghosts], 'auto');
    expect(r.guitar.present).toBe(false);
    expect(r.bassNotes).toHaveLength(bass.length);
  });

  it('lets register overrule a note that bled into the wrong stem', () => {
    // A high melody note can't be bass, wherever it was heard.
    const bass = tag(bassLine(), 'bass');
    const melody = tag(guitarMelody(), 'guitar');
    const bled = { ...note(76, 3.02, 0.3, 0.6, 0.2), stem: 'bass' as const };
    const r = detectInstruments([...bass, ...melody, bled], 'auto');
    expect(r.bassNotes.some((n) => n.pitch === 76)).toBe(false);
    expect(r.guitarNotes.some((n) => n.pitch === 76)).toBe(true);
  });

  it('merges a note heard in both stems into one, keeping the stronger stem', () => {
    const merged = mergeFragments([
      { ...note(45, 1.0, 0.4, 0.8), stem: 'guitar' },
      { ...note(45, 1.012, 0.38, 0.3), stem: 'bass' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].stem).toBe('guitar');
  });
});
