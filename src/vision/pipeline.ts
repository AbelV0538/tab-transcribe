/**
 * Playthrough video analysis: calibrate the neck on one frame, follow it through the video and
 * locate the fretting hand, producing fret-window hints for the transcription. Frames are
 * captured here (it needs a video element) and analysed in a worker.
 */
import type { InstrumentKind } from '../music/tunings';
import type { PlaythroughResult } from './analyzer';
import { calibrateNeck, type FretMark, type NeckModel } from './neck';
import { VideoFrames } from './video';
import type { VisionRequest } from './worker';

/** Analysis frame width in pixels, and frames analysed per second of video. */
export const ANALYSIS_WIDTH = 360;
const FPS = 10;

export interface Calibration {
  /** Time of the frame the marks were placed on. */
  time: number;
  /** Marks in normalised frame coordinates (0..1). */
  marks: FretMark[];
}

export interface VideoAnalysis extends PlaythroughResult {
  instrument: InstrumentKind;
  /** Neck model in analysis-frame pixels (width ANALYSIS_WIDTH). */
  model: NeckModel;
  width: number;
  height: number;
}

export function neckModelFor(calibration: Calibration, width: number, height: number, instrument: InstrumentKind): NeckModel {
  return calibrateNeck(
    calibration.marks.map((m) => ({ fret: m.fret, x: m.x * width, y: m.y * height })),
    instrument,
  );
}

/** Index of the analysed frame nearest to `time`. */
export function frameIndexAt(analysis: VideoAnalysis, time: number): number {
  const { times } = analysis;
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  return hi >= 0 && Math.abs(times[hi] - time) < Math.abs(times[lo] - time) ? hi : lo;
}

export async function analysePlaythrough(
  file: Blob,
  calibration: Calibration,
  instrument: InstrumentKind,
  onProgress: (stage: string, fraction: number) => void = () => {},
  /** Length of the recording from its audio, used if the video doesn't report one. */
  fallbackDuration = 0,
): Promise<VideoAnalysis> {
  const stage = 'Following the neck in the video';
  onProgress(stage, 0);
  const frames = await VideoFrames.open(file, ANALYSIS_WIDTH, fallbackDuration);
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  try {
    const { width, height } = frames;
    const model = neckModelFor(calibration, width, height, instrument);
    const reference = await frames.grayAt(calibration.time);
    const post = (msg: VisionRequest, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
    const result = await new Promise<PlaythroughResult>((resolve, reject) => {
      let pending = 0;
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'frameDone') pending--;
        else if (m.type === 'result') resolve(m.result);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The video analysis failed'));
      post({ type: 'init', reference, model, instrument }, [reference.data.buffer]);
      frames
        .capture(
          FPS,
          (time, bitmap) => {
            pending++;
            post({ type: 'frame', time, bitmap }, [bitmap]);
          },
          () => pending,
          (f) => onProgress(stage, f),
        )
        .then(async () => {
          while (pending > 0) await new Promise((r) => setTimeout(r, 20));
          onProgress('Finding the fretting hand', 1);
          post({ type: 'finish' });
        }, reject);
    });
    const gaps = result.times.slice(1).map((t, i) => t - result.times[i]);
    console.info(
      `[video] ${result.times.length} frames over ${frames.duration.toFixed(1)} s, largest gap ${Math.max(0, ...gaps).toFixed(2)} s, ` +
        `neck tracked in ${Math.round(result.tracked * 100)}%, hand hints ${result.hints.length}`,
    );
    return { instrument, model, width, height, ...result };
  } finally {
    worker.terminate();
    frames.close();
  }
}
