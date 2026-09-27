import { describe, expect, it } from 'vitest';
import type { AudioAnalysis } from '../src/engine/types';
import { toMidi } from '../src/export/midi';
import { splitDuration, toMusicXml } from '../src/export/musicxml';
import { toTabText } from '../src/export/text';
import { DEFAULT_SETTINGS, interpret } from '../src/music/interpret';
import { bassLine, guitarChords } from './helpers/notes';

function analysis(): AudioAnalysis {
  const notes = [...bassLine(0.5), ...guitarChords(0.5)];
  const rate = 22050 / 256;
  const env = new Float32Array(Math.ceil(10 * rate));
  for (const n of notes) env[Math.round(n.start * rate)] += 1;
  return { duration: 10, notes, onsetEnvelope: env, envelopeRate: rate, tuningCents: 0, backend: 'test' };
}

describe('exports', () => {
  const t = interpret(analysis(), DEFAULT_SETTINGS);

  it('interprets a band arrangement into guitar and bass tracks', () => {
    expect(t.tracks.map((x) => x.instrument)).toEqual(['guitar', 'bass']);
    expect(t.grid.bpm).toBe(120);
  });

  it('writes a valid multi-track MIDI file', () => {
    const bytes = toMidi(t, 'Song');
    const text = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
    expect(text(0, 4)).toBe('MThd');
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(8)).toBe(1); // format 1
    expect(view.getUint16(10)).toBe(3); // conductor + guitar + bass
    expect(view.getUint16(12)).toBe(480);
    // Walk the chunks and count note-on events.
    let offset = 14;
    let noteOns = 0;
    for (let k = 0; k < 3; k++) {
      expect(text(offset, offset + 4)).toBe('MTrk');
      const len = view.getUint32(offset + 4);
      const data = bytes.subarray(offset + 8, offset + 8 + len);
      for (let i = 0; i < data.length - 2; i++) if ((data[i] & 0xf0) === 0x90 && data[i + 2] > 0) noteOns++;
      offset += 8 + len;
    }
    expect(offset).toBe(bytes.length);
    expect(noteOns).toBeGreaterThanOrEqual(t.tracks.reduce((s, tr) => s + tr.notes.length, 0));
  });

  it('splits durations into notatable values', () => {
    expect(splitDuration(5, 4).map((v) => v.slots)).toEqual([4, 1]);
    expect(splitDuration(7, 4).map((v) => v.slots)).toEqual([6, 1]);
    expect(splitDuration(16, 4).map((v) => v.type)).toEqual(['whole']);
    expect(splitDuration(2, 3)[0]).toMatchObject({ type: 'quarter', triplet: true });
  });

  it('writes MusicXML with tablature', () => {
    const xml = toMusicXml(t, 'Song & Dance');
    expect(xml).toContain('<work-title>Song &amp; Dance</work-title>');
    expect(xml.match(/<part id=/g)).toHaveLength(2);
    expect(xml).toContain('<sign>TAB</sign>');
    expect(xml).toContain('<staff-lines>4</staff-lines>');
    // Every measure of a part adds up to a full 4/4 bar (16 sixteenth-note divisions).
    const part = xml.slice(xml.indexOf('<part id="P2">'));
    for (const m of part.split('<measure').slice(1)) {
      const durations = [...m.matchAll(/<note>(?:(?!<\/note>).)*?<duration>(\d+)<\/duration>/g)].filter((x) => !x[0].includes('<chord/>'));
      expect(durations.reduce((s, d) => s + Number(d[1]), 0)).toBe(16);
    }
    // Balanced tags.
    const opens = (xml.match(/<note>/g) ?? []).length;
    expect((xml.match(/<\/note>/g) ?? []).length).toBe(opens);
  });

  it('writes a readable text tab', () => {
    const txt = toTabText(t, 'Song');
    expect(txt).toContain('Guitar — tuning: Standard');
    expect(txt).toContain('Bass — tuning: Standard 4-string');
    expect(txt).toMatch(/^G\|/m);
    expect(txt).toMatch(/^e\|/m);
  });
});
