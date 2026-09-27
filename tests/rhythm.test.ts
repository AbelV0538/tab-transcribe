import { describe, expect, it } from 'vitest';
import { buildBeatGrid, timeToSlot, slotToTime, chooseSubdivision } from '../src/music/rhythm';

const RATE = 22050 / 256;

function envelopeFor(onsets: number[], duration: number, jitter = 0): Float32Array {
  const env = new Float32Array(Math.ceil(duration * RATE));
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < env.length; i++) env[i] = 0.05 * Math.abs(rand());
  for (const t of onsets) {
    const i = Math.round((t + jitter * rand()) * RATE);
    if (i < env.length) env[i] += 1;
  }
  return env;
}

describe('beat tracking', () => {
  it('finds 120 BPM from straight eighth notes', () => {
    const onsets = Array.from({ length: 64 }, (_, i) => 0.5 + i * 0.25);
    const env = envelopeFor(onsets, 17);
    const hints = onsets.map((t, i) => ({ time: t, weight: i % 4 === 0 ? 1 : 0.6, pitch: i % 8 === 0 ? 33 : 50 }));
    const grid = buildBeatGrid(env, RATE, hints, { duration: 17, bpm: null, beatsPerBar: 4, subdivision: 'auto' });
    expect(Math.abs(grid.bpm - 120)).toBeLessThanOrEqual(2);
    expect(grid.subdivision).toBe(4);
    // Every onset lands on an even (eighth-note) slot and the first on the downbeat.
    const slots = onsets.map((t) => timeToSlot(grid, t));
    expect(slots[0]).toBe(0);
    expect(slots.every((s) => s % 2 === 0)).toBe(true);
    expect(slots[8]).toBe(16);
  });

  it('uses a fixed tempo when given', () => {
    const onsets = Array.from({ length: 32 }, (_, i) => 1 + i * 0.6);
    const env = envelopeFor(onsets, 21);
    const grid = buildBeatGrid(env, RATE, onsets.map((t) => ({ time: t, weight: 1, pitch: 40 })), { duration: 21, bpm: 100, beatsPerBar: 4, subdivision: 4 });
    expect(grid.bpm).toBe(100);
    expect(Math.abs(slotToTime(grid, timeToSlot(grid, 1.0)) - 1.0)).toBeLessThan(0.03);
  });

  it('detects triplet feel', () => {
    const beats = Array.from({ length: 40 }, (_, i) => i * 0.5);
    const onsets = beats.flatMap((b) => [b, b + 0.5 / 3, b + 1 / 3]);
    expect(chooseSubdivision(beats, onsets)).toBe(3);
    expect(chooseSubdivision(beats, beats.flatMap((b) => [b, b + 0.125, b + 0.25]))).toBe(4);
  });
});
