import { describe, expect, it } from 'vitest';
import { assignFingerings, type NoteIn } from '../src/music/fingering';
import { BASS_TUNINGS, GUITAR_TUNINGS } from '../src/music/tunings';

const guitar = { tuning: GUITAR_TUNINGS[0], instrument: 'guitar' as const, frets: 22, capo: 0 };
const bass = { tuning: BASS_TUNINGS[0], instrument: 'bass' as const, frets: 21, capo: 0 };

function seq(pitches: number[], step = 0.25): NoteIn[] {
  return pitches.map((p, i) => ({ pitch: p, start: i * step, end: i * step + step * 0.9, amplitude: 0.8 }));
}
function chord(pitches: number[], start = 0): NoteIn[] {
  return pitches.map((p) => ({ pitch: p, start, end: start + 1, amplitude: 0.8 }));
}
const pos = (r: ReturnType<typeof assignFingerings>) => r.notes.map((n) => `${n.string}:${n.fret}`);

describe('guitar fingering', () => {
  it('plays a C major scale in open position', () => {
    const r = assignFingerings(seq([48, 50, 52, 53, 55, 57, 59, 60]), guitar);
    // C(A3) D(D0) E(D2) F(D3) G(G0) A(G2) B(B0) C(B1)
    expect(pos(r)).toEqual(['1:3', '2:0', '2:2', '2:3', '3:0', '3:2', '4:0', '4:1']);
  });

  it('plays an open G chord with the standard shape', () => {
    const r = assignFingerings(chord([43, 47, 50, 55, 59, 67]), guitar);
    expect(pos(r)).toEqual(['0:3', '1:2', '2:0', '3:0', '4:0', '5:3']);
  });

  it('plays an E5 power chord on the low strings', () => {
    const r = assignFingerings(chord([40, 47, 52]), guitar);
    expect(pos(r)).toEqual(['0:0', '1:2', '2:2']);
  });

  it('plays an F barre chord (E shape, 1st fret)', () => {
    const r = assignFingerings(chord([41, 48, 53, 57, 60, 65]), guitar);
    expect(pos(r)).toEqual(['0:1', '1:3', '2:3', '3:2', '4:1', '5:1']);
  });

  it('keeps a fast high lick in position instead of jumping down the neck', () => {
    // E5 G5 A5 G5 E5 D5 C5 A4 around the 12th fret
    const r = assignFingerings(seq([76, 79, 81, 79, 76, 74, 72, 69], 0.12), guitar);
    const frets = r.notes.map((n) => n.fret);
    expect(Math.min(...frets)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(5);
  });

  it('never assigns two simultaneous notes to one string', () => {
    const r = assignFingerings(chord([40, 45, 50, 55, 59, 64]), guitar);
    expect(new Set(r.notes.map((n) => n.string)).size).toBe(6);
  });

  it('drops the weakest notes when there are more notes than strings', () => {
    const notes = chord([40, 45, 50, 55, 59, 64, 67]);
    notes[6].amplitude = 0.1;
    const r = assignFingerings(notes, guitar);
    expect(r.notes).toHaveLength(6);
    expect(r.dropped.map((n) => n.pitch)).toEqual([67]);
  });

  it('folds notes below the range up an octave', () => {
    const r = assignFingerings(seq([33]), guitar);
    expect(r.notes[0].pitch).toBe(45);
    expect(r.notes[0].folded).toBe(true);
  });

  it('respects a capo', () => {
    const r = assignFingerings(chord([42, 49, 54]), { ...guitar, capo: 2 });
    expect(pos(r)).toEqual(['0:0', '1:2', '2:2']);
  });
});

describe('bass fingering', () => {
  it('plays a root-fifth-octave pattern in one position', () => {
    // A1 E2 A2 (A string open, D string 2, G string 2) → prefer 1:0 2:2 3:2
    const r = assignFingerings(seq([33, 40, 45]), bass);
    expect(pos(r)).toEqual(['1:0', '2:2', '3:2']);
  });

  it('plays a walking line without big shifts', () => {
    const line = [28, 32, 35, 37, 33, 37, 40, 42, 38, 42, 45, 47];
    const r = assignFingerings(seq(line), bass);
    const fretted = r.notes.map((n) => n.fret).filter((f) => f > 0);
    expect(Math.max(...fretted)).toBeLessThanOrEqual(7);
  });
});
