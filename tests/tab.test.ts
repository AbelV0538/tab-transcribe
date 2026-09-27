import { describe, expect, it } from 'vitest';
import { layoutBars, renderAsciiTab, renderBar } from '../src/music/tab';
import { GUITAR_TUNINGS } from '../src/music/tunings';
import { chordName } from '../src/music/theory';

describe('tab layout', () => {
  const notes = [
    { pitch: 40, string: 0, fret: 0, slot: 0, endSlot: 4, amplitude: 1 },
    { pitch: 47, string: 1, fret: 2, slot: 0, endSlot: 4, amplitude: 1 },
    { pitch: 52, string: 2, fret: 2, slot: 0, endSlot: 4, amplitude: 1 },
    { pitch: 64, string: 5, fret: 12, slot: 6, endSlot: 8, amplitude: 1 },
    { pitch: 45, string: 1, fret: 0, slot: 16, endSlot: 18, amplitude: 1 },
  ];
  it('splits notes into bars', () => {
    const bars = layoutBars(notes, 16);
    expect(bars).toHaveLength(2);
    expect(bars[0].columns[0]).toHaveLength(3);
    expect(bars[1].columns[0][0]).toMatchObject({ string: 1, fret: 0 });
  });
  it('renders aligned text with two-digit frets', () => {
    const bars = layoutBars(notes, 16);
    const lines = renderBar(bars[0], 6);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    expect(lines[0]).toContain('12');
    expect(lines[5].startsWith('-0')).toBe(true);
  });
  it('renders a full ascii tab with labels and chord names', () => {
    const text = renderAsciiTab(layoutBars(notes, 16), GUITAR_TUNINGS[0], { barsPerLine: 4 });
    const lines = text.split('\n');
    expect(lines.some((l) => l.startsWith('e|'))).toBe(true);
    expect(lines.some((l) => l.startsWith('E|-0'))).toBe(true);
    expect(text).toContain('E5');
  });
  it('names chords', () => {
    expect(chordName([40, 47, 52, 56, 59, 64])).toBe('E');
    expect(chordName([45, 52, 57, 60, 64])).toBe('Am');
    expect(chordName([43, 47, 50, 55, 59, 65])).toBe('G7');
    expect(chordName([40, 47])).toBe('E5');
  });
});
