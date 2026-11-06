import { describe, expect, it } from 'vitest';
import { halveRate } from '../src/audio/resample';
import { SEGMENT, STEM_ORDER, segmentOffsets, separate, type StemModel } from '../src/separation/demucs';
import { chooseGuitarStems, instrumentStems } from '../src/separation/stems';

/** A fake network whose stem k is (k + 1) × its input, so every stem is easy to predict. */
function scalingModel(calls: { n: number } = { n: 0 }): StemModel {
  return {
    async run(x) {
      calls.n++;
      expect(x.length).toBe(2 * SEGMENT);
      const out = new Float32Array(STEM_ORDER.length * 2 * SEGMENT);
      for (let k = 0; k < STEM_ORDER.length; k++) for (let i = 0; i < x.length; i++) out[k * 2 * SEGMENT + i] = (k + 1) * x[i];
      return out;
    },
  };
}

function signal(n: number, seed: number, dc = 0): Float32Array {
  const x = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    x[i] = dc + 0.3 * Math.sin(i * 0.013 * seed) + 0.2 * (s / 2147483648 - 0.5);
  }
  return x;
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

describe('instrument separation (overlap-add around the network)', () => {
  it('covers the recording with 25 % overlapping segments', () => {
    expect(segmentOffsets(1000)).toEqual([0]);
    const stride = Math.floor(0.75 * SEGMENT);
    expect(segmentOffsets(SEGMENT)).toEqual([0, stride]);
    const offs = segmentOffsets(3 * SEGMENT);
    expect(offs[offs.length - 1] + SEGMENT).toBeGreaterThanOrEqual(3 * SEGMENT);
  });

  for (const length of [1000, SEGMENT, Math.round(2.3 * SEGMENT) + 17]) {
    it(`reconstructs every stem exactly for ${length} samples`, async () => {
      const left = signal(length, 3, 0.01);
      const right = signal(length, 7, 0.01);
      const calls = { n: 0 };
      const stems = await separate(left, right, scalingModel(calls), ['bass', 'guitar', 'other'], () => {});
      expect(calls.n).toBe(segmentOffsets(length).length);
      const mono = Float32Array.from(left, (l, i) => 0.5 * (l + right[i]));
      let mean = 0;
      for (const v of mono) mean += v / length;
      for (const name of ['bass', 'guitar', 'other'] as const) {
        const k = STEM_ORDER.indexOf(name) + 1;
        // stem = k × normalised input, de-normalised: k × (mono − mean) + mean.
        const expected = Float32Array.from(mono, (m) => k * (m - mean) + mean);
        expect(stems[name]!.length).toBe(length);
        expect(maxDiff(stems[name]!, expected)).toBeLessThan(1e-4);
      }
      expect(Object.keys(stems).sort()).toEqual(['bass', 'guitar', 'other']);
    });
  }

  it('reports progress per segment and rejects unknown stems', async () => {
    const seen: number[] = [];
    await separate(signal(2 * SEGMENT, 1), signal(2 * SEGMENT, 2), scalingModel(), ['drums'], (f) => seen.push(f));
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.length).toBe(segmentOffsets(2 * SEGMENT).length);
    await expect(separate(new Float32Array(10), new Float32Array(10), scalingModel(), ['kazoo' as never])).rejects.toThrow(/Unknown stem/);
  });

  it('copes with digital silence', async () => {
    const stems = await separate(new Float32Array(5000), new Float32Array(5000), scalingModel(), ['bass']);
    expect(maxDiff(stems.bass!, new Float32Array(5000))).toBe(0);
  });

  it('sums the stems that count as guitar', () => {
    const a = Float32Array.of(1, 2, 3);
    const b = Float32Array.of(10, 20, 30);
    const c = Float32Array.of(5, 5, 5);
    expect(Array.from(instrumentStems({ guitar: a, other: b, bass: c }, ['guitar', 'other']).guitar)).toEqual([11, 22, 33]);
    expect(instrumentStems({ guitar: a, other: b, bass: c }, ['guitar']).guitar).toBe(a);
    expect(() => instrumentStems({ guitar: a }, ['guitar'])).toThrow(/bass/);
  });

  it('falls back to guitar + other + piano when the separator did not recognise the guitar', () => {
    const loud = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i * 0.1));
    const faint = loud.map((v) => v * 0.02);
    expect(chooseGuitarStems({ guitar: loud, other: loud, piano: faint, bass: loud })).toEqual(['guitar']);
    expect(chooseGuitarStems({ guitar: faint, other: loud, piano: loud, bass: loud })).toEqual(['guitar', 'other', 'piano']);
    const s = instrumentStems({ guitar: faint, other: loud, piano: faint, bass: loud });
    expect(s.guitarFrom).toEqual(['guitar', 'other', 'piano']);
    expect(s.guitar[10]).toBeCloseTo(loud[10] * 1.04, 5);
    // Digital silence everywhere: nothing to fall back to.
    expect(chooseGuitarStems({ guitar: new Float32Array(10), other: new Float32Array(10), piano: new Float32Array(10) })).toEqual(['guitar']);
  });
});

describe('2:1 decimation (44.1 → 22.05 kHz)', () => {
  const sine = (f: number, n = 44100) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / 44100));

  it('passes the audible band unchanged', () => {
    for (const f of [100, 1000, 5000]) {
      const y = halveRate(sine(f));
      expect(y.length).toBe(22050);
      const db = 20 * Math.log10(rms(y, 200, 21850) / Math.SQRT1_2);
      expect(Math.abs(db)).toBeLessThan(0.1);
    }
  });

  it('removes content above the new Nyquist frequency instead of aliasing it', () => {
    for (const f of [12000, 15000, 20000]) {
      const y = halveRate(sine(f));
      expect(20 * Math.log10(rms(y, 200, 21850) / Math.SQRT1_2)).toBeLessThan(-60);
    }
  });

  it('keeps timing: input sample 2m becomes output sample m', () => {
    const x = new Float32Array(1001);
    x[500] = 1;
    const y = halveRate(x);
    expect(y.length).toBe(501);
    let peak = 0;
    for (let i = 1; i < y.length; i++) if (y[i] > y[peak]) peak = i;
    expect(peak).toBe(250);
  });
});
