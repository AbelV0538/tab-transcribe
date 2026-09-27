/** Per-frame playthrough analysis (neck tracking + hand strips), independent of where frames come from. */
import type { HandHint } from '../music/playthrough';
import type { InstrumentKind } from '../music/tunings';
import { HandLocator, sampleStrip, stripSpec, toHints, type HandObservation } from './hand';
import { blur, downsample, type GrayImage } from './image';
import type { NeckModel } from './neck';
import { IDENTITY, NeckTracker, type Affine } from './track';

export interface PlaythroughResult {
  times: number[];
  /** Tracked warp per analysed frame (null where the neck was lost). */
  warps: Array<Affine | null>;
  observations: HandObservation[];
  hints: HandHint[];
  /** Fraction of frames where the neck was tracked. */
  tracked: number;
}

export class PlaythroughAnalyzer {
  private readonly tracker: NeckTracker;
  private readonly locator: HandLocator;
  private readonly spec;
  private readonly times: number[] = [];
  private readonly warps: Array<Affine | null> = [];
  /** Tracked frames (time, warp), to start each new frame from the nearest one in time. */
  private readonly good: Array<[number, Affine]> = [];

  /** `reference` is the calibration frame, at the same resolution as the frames to come. */
  constructor(
    reference: GrayImage,
    private readonly model: NeckModel,
    instrument: InstrumentKind,
  ) {
    this.tracker = new NeckTracker(reference, model, instrument === 'bass' ? 21 : 22);
    this.spec = stripSpec(instrument === 'bass' ? 15 : 17);
    this.locator = new HandLocator(this.spec, sampleStrip(blur(downsample(reference)), 2, model, IDENTITY, 1, 0, this.spec));
  }

  /** Frames may arrive in any order, but tracking is quickest and surest in time order. */
  addFrame(time: number, img: GrayImage): Affine | null {
    let init: Affine = IDENTITY;
    let distance = Infinity;
    for (let i = this.good.length - 1; i >= 0 && i >= this.good.length - 400; i--) {
      const d = Math.abs(this.good[i][0] - time);
      if (d < distance) {
        distance = d;
        init = this.good[i][1];
      }
    }
    const r = this.tracker.track(img, init, distance > 0.25);
    if (r.ok) this.good.push([time, r.warp]);
    this.times.push(time);
    this.warps.push(r.ok ? r.warp : null);
    this.locator.add(time, r.ok ? sampleStrip(blur(downsample(img)), 2, this.model, r.warp, r.gain, r.bias, this.spec) : null, r.score);
    return r.ok ? r.warp : null;
  }

  finish(): PlaythroughResult {
    const unsorted = this.locator.observations();
    const order = this.times.map((_, i) => i).sort((a, b) => this.times[a] - this.times[b]);
    const observations = order.map((i) => unsorted[i]);
    const warps = order.map((i) => this.warps[i]);
    return {
      times: order.map((i) => this.times[i]),
      warps,
      observations,
      hints: toHints(observations, (i) => warps[i] !== null),
      tracked: warps.filter(Boolean).length / Math.max(1, warps.length),
    };
  }
}
