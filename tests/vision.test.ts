import { describe, expect, it } from 'vitest';
import { HandLocator, sampleStrip, stripSpec, toHints } from '../src/vision/hand';
import { blur, downsample, type GrayImage } from '../src/vision/image';
import { calibrateNeck, fretSpaceCentre, neckPoint, pointToFret } from '../src/vision/neck';
import { IDENTITY, NeckTracker, applyAffine, type Affine } from '../src/vision/track';
import { fretSpacePoint, renderFretboard, type FretboardPose, type HandPose } from './helpers/fretboard';

const W = 360;
const H = 640;
const BASE: FretboardPose = { nutX: -120, nutY: 250, angle: 22, scale: 900 };
const frame = (pose: FretboardPose, hand: HandPose | null = null): GrayImage => ({ width: W, height: H, data: renderFretboard(W, H, pose, hand) });
const marks = (pose: FretboardPose, frets: number[]) => frets.map((fret) => ({ fret, x: fretSpacePoint(pose, fret)[0], y: fretSpacePoint(pose, fret)[1] }));

describe('neck model', () => {
  it('passes through the calibration marks and inverts', () => {
    for (const frets of [[5, 12], [3, 9, 15]]) {
      const m = calibrateNeck(marks(BASE, frets), 'bass');
      for (const f of [3, 5, 7, 9, 12, 15]) {
        const [x, y] = neckPoint(m, f - 0.5, 0);
        const [tx, ty] = fretSpacePoint(BASE, f);
        // fret space centre is at D = average of its wires, not at fret f-0.5: allow a small gap.
        expect(Math.hypot(x - tx, y - ty)).toBeLessThan(1.5);
        expect(pointToFret(m, neckPoint(m, f - 0.3, 0.4)).fret).toBeCloseTo(f - 0.3, 5);
      }
    }
    expect(fretSpaceCentre(12)).toBeCloseTo((1 - 2 ** (-11 / 12) + 0.5) / 2, 10);
  });
  it('rejects unusable marks', () => {
    expect(() => calibrateNeck([{ x: 0, y: 0, fret: 5 }], 'bass')).toThrow();
    expect(() => calibrateNeck([{ x: 0, y: 0, fret: 5 }, { x: 50, y: 0, fret: 5 }], 'bass')).toThrow();
  });
});

describe('neck tracker', () => {
  const model = calibrateNeck(marks(BASE, [5, 12]), 'bass');
  const tracker = new NeckTracker(frame(BASE), model, 21);

  it('recovers moves, rotations and small scale changes', () => {
    const poses: FretboardPose[] = [
      { ...BASE, nutX: BASE.nutX + 18, nutY: BASE.nutY - 12 },
      { ...BASE, angle: BASE.angle + 6 },
      { ...BASE, angle: BASE.angle - 5, nutY: BASE.nutY + 20 },
      // The player leaning towards the camera over a few frames.
      { ...BASE, angle: BASE.angle - 5, nutY: BASE.nutY + 20, scale: BASE.scale * 1.01 },
      { ...BASE, angle: BASE.angle - 5, nutY: BASE.nutY + 20, scale: BASE.scale * 1.02, nutX: BASE.nutX - 5 },
      { ...BASE, angle: BASE.angle - 5, nutY: BASE.nutY + 20, scale: BASE.scale * 1.03, nutX: BASE.nutX - 10 },
    ];
    let prev: Affine = IDENTITY;
    for (const pose of poses) {
      const r = tracker.track(frame(pose, { from: 4.2, to: 7.5 }), prev);
      expect(r.ok).toBe(true);
      for (const f of [3, 7, 12]) {
        const [x, y] = applyAffine(r.warp, ...neckPoint(model, f - 0.5, 0));
        const [tx, ty] = fretSpacePoint(pose, f);
        expect(Math.hypot(x - tx, y - ty)).toBeLessThan(2.5);
      }
      prev = r.warp;
    }
  });
});

describe('hand locator', () => {
  it('finds the fretting hand and turns it into fret windows', () => {
    const model = calibrateNeck(marks(BASE, [5, 12]), 'bass');
    const tracker = new NeckTracker(frame(BASE), model, 21);
    const spec = stripSpec(15);
    const locator = new HandLocator(spec);
    // Hand mostly over frets 4-6 (a player's home position), sometimes higher, sometimes off the
    // visible board towards the nut.
    const script: Array<HandPose | null> = [];
    for (let i = 0; i < 30; i++) script.push(i % 10 === 3 ? { from: 6.3, to: 9.2 } : i % 10 === 7 ? null : { from: 3.6, to: 5.6 });
    let prev: Affine = IDENTITY;
    script.forEach((hand, i) => {
      const pose = { ...BASE, angle: BASE.angle + 3 * Math.sin(i / 4), nutY: BASE.nutY + 8 * Math.cos(i / 5) };
      const img = frame(pose, hand);
      const r = tracker.track(img, prev);
      if (r.ok) prev = r.warp;
      locator.add(i * 0.1, r.ok ? sampleStrip(blur(downsample(img)), 2, model, r.warp, r.gain, r.bias, spec) : null, r.score);
    });
    const obs = locator.observations();
    script.forEach((hand, i) => {
      if (hand === null) expect(obs[i].from).toBeNull();
      else {
        expect(obs[i].from).not.toBeNull();
        expect(Math.abs(obs[i].from! - hand.from)).toBeLessThan(0.8);
        expect(Math.abs(obs[i].to! - hand.to)).toBeLessThan(0.8);
      }
    });
    const hints = toHints(obs, () => true);
    expect(hints[3]).toMatchObject({ lo: 6 });
    expect(hints[3].hi).toBeGreaterThanOrEqual(10);
    expect(hints[0]).toMatchObject({ lo: 3 });
    expect(hints[0].hi).toBeGreaterThanOrEqual(6);
    // No hand on a well-tracked board: it must be below the visible frets.
    expect(hints[7]).toMatchObject({ lo: 0, confidence: 0.4 });
  });
});
