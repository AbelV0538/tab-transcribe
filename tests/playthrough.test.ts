import { describe, expect, it } from 'vitest';
import type { AudioAnalysis } from '../src/engine/types';
import { assignFingerings } from '../src/music/fingering';
import { DEFAULT_SETTINGS, interpret } from '../src/music/interpret';
import { correctWithHands, hintAt, pitchMiss, type HandHint, type Playthrough } from '../src/music/playthrough';
import { BASS_TUNINGS } from '../src/music/tunings';
import { note } from './helpers/notes';

const bass = BASS_TUNINGS[0];
const hint = (time: number, lo: number, hi: number, confidence = 0.9, seen = true): HandHint => ({ time, lo, hi, confidence, seen });

describe('hand hints', () => {
  const hints = [hint(0, 0, 3), hint(0.5, 5, 8, 0.5), hint(0.6, 5, 8, 0.95), hint(2, 10, 13)];
  it('uses the most confident hint around the onset', () => {
    expect(hintAt(hints, 0.55)).toMatchObject({ time: 0.6 });
    expect(hintAt(hints, 0.02)).toMatchObject({ lo: 0, hi: 3 });
    expect(hintAt(hints, 1.2)).toBeNull();
  });
  it('measures how far a pitch is from the hand', () => {
    // A2 (45) is fret 5 on the E string, fret 0 on A: open strings always fit.
    expect(pitchMiss(45, bass, 0, 21, hint(0, 10, 13))).toBe(0);
    // C3 (48) is E20, A15, D10 or G5: D10 is under the hand.
    expect(pitchMiss(48, bass, 0, 21, hint(0, 10, 13))).toBe(0);
    // F#1 (30) is only playable at E string fret 2.
    expect(pitchMiss(30, bass, 0, 21, hint(0, 7, 10))).toBe(5);
  });
});

describe('fingering follows the filmed hand', () => {
  const line = [45, 47, 48, 50].map((p, i) => ({ pitch: p, start: i * 0.5, end: i * 0.5 + 0.4, amplitude: 0.8 }));
  const opts = { tuning: bass, instrument: 'bass' as const, frets: 21, capo: 0 };
  it('without video, picks one comfortable position (7th)', () => {
    const r = assignFingerings(line, opts);
    expect(r.notes.map((n) => n.fret)).toEqual([7, 9, 10, 7]);
  });
  it('with the hand at frets 1-5, plays low on the G string instead', () => {
    const r = assignFingerings(line, { ...opts, hand: () => hint(0, 1, 5) });
    expect(r.notes.slice(0, 3).map((n) => `${n.string}:${n.fret}`)).toEqual(['3:2', '3:4', '3:5']);
  });
  it('with the hand at frets 10-13, plays there', () => {
    const r = assignFingerings(line, { ...opts, hand: () => hint(0, 10, 13) });
    for (const n of r.notes) expect(n.fret === 0 || (n.fret >= 9 && n.fret <= 14)).toBe(true);
    expect(r.notes.filter((n) => n.fret >= 10).length).toBeGreaterThanOrEqual(3);
  });
});

describe('note correction', () => {
  const pt: Playthrough = { instrument: 'bass', hints: [hint(0, 0, 4), hint(1, 0, 4)] };
  it('moves a bass note detected an octave too high into the hand position', () => {
    // E2 at 52 can't be reached with the hand at frets 0-4 (it needs D fret 14 or G fret 9).
    const r = correctWithHands([note(52, 0), note(33, 1)], pt, bass, 0, 21);
    expect(r.notes.map((n) => n.pitch)).toEqual([40, 33]);
    expect(r.octaveFixes).toBe(1);
    expect(r.covered).toBe(2);
  });
  it('only overrules the heard octave when the hand was clearly seen', () => {
    const heard = [note(52, 0)];
    // Hand only assumed to be at the nut (not seen on the board): the note is kept, down-weighted.
    const assumed = correctWithHands(heard, { instrument: 'bass', hints: [hint(0, 0, 4, 0.4, false)] }, bass, 0, 21);
    expect(assumed.notes[0].pitch).toBe(52);
    expect(assumed.octaveFixes).toBe(0);
    expect(assumed.weights[0]).toBeLessThan(1);
    // Seen, but not confidently.
    const unsure = correctWithHands(heard, { instrument: 'bass', hints: [hint(0, 0, 4, 0.5)] }, bass, 0, 21);
    expect(unsure.notes[0].pitch).toBe(52);
    // Clearly seen: moved to E2.
    const sure = correctWithHands(heard, { instrument: 'bass', hints: [hint(0, 0, 4, 0.8)] }, bass, 0, 21);
    expect(sure.notes[0].pitch).toBe(40);
  });

  it('moves notes down an octave too', () => {
    // B1 (35) only exists at E7; B2 (47) is A14, under a hand at frets 12-15.
    const r = correctWithHands([note(35, 0)], { instrument: 'bass', hints: [hint(0, 12, 15)] }, bass, 0, 21);
    expect(r.notes[0].pitch).toBe(47);
  });
  it('down-weights notes that no octave makes playable', () => {
    // F#1 (30) is E2; F#2 (42) is E14 or A9: neither is within frets 15-16.
    const r = correctWithHands([note(30, 0), note(33, 0.5)], { instrument: 'bass', hints: [hint(0, 15, 16), hint(0.5, 15, 16)] }, bass, 0, 21);
    expect(r.notes.map((n) => n.pitch)).toEqual([30, 33]);
    expect(r.weights[0]).toBeLessThan(0.5);
    expect(r.weights[1]).toBeGreaterThan(1); // open A is always playable
  });
});

describe('interpret with a playthrough', () => {
  function analysis(notes: ReturnType<typeof note>[]): AudioAnalysis {
    const rate = 22050 / 256;
    const env = new Float32Array(Math.ceil(6 * rate));
    for (const n of notes) env[Math.round(n.start * rate)] += 1;
    return { duration: 6, notes, onsetEnvelope: env, envelopeRate: rate, tuningCents: 0, backend: 'test' };
  }
  const line = [40, 43, 45, 47, 45, 43, 40, 38].map((p, i) => note(p, 0.5 + i * 0.5, 0.45, 0.8, 0.8));

  it('fingers the filmed bass line where the hand is', () => {
    const plain = interpret(analysis(line), DEFAULT_SETTINGS);
    const video = interpret(analysis(line), DEFAULT_SETTINGS, { instrument: 'bass', hints: line.map((n) => hint(n.start, 5, 9)) });
    const frets = (t: typeof plain) => t.tracks.find((x) => x.instrument === 'bass')!.notes.map((n) => n.fret);
    expect(Math.max(...frets(plain))).toBeLessThanOrEqual(5);
    // D2 (38) only exists at E-string fret 10 or open D; everything else sits in frets 5-9.
    expect(frets(video).every((f) => f === 0 || (f >= 5 && f <= 10))).toBe(true);
    expect(video.video).toMatchObject({ instrument: 'bass', notes: 8, notesWithHand: 8 });
  });

  it('keeps the filmed instrument even when the audio alone does not show it', () => {
    // A low single-note riff that the audio alone calls guitar, filmed on a bass.
    const riff = [40, 43, 45, 40, 47, 45, 43, 42].map((p, i) => note(p, 0.5 + i * 0.25, 0.22, 0.7, 0.3));
    expect(interpret(analysis(riff), DEFAULT_SETTINGS).tracks.map((t) => t.instrument)).toEqual(['guitar']);
    const video = interpret(analysis(riff), DEFAULT_SETTINGS, { instrument: 'bass', hints: riff.map((n) => hint(n.start, 0, 4)) });
    const bassTrack = video.tracks.find((t) => t.instrument === 'bass');
    expect(bassTrack?.notes.length).toBe(8);
  });
});
