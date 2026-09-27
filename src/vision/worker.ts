/// <reference lib="webworker" />
/** Runs the playthrough analysis off the main thread; frames arrive as ImageBitmaps. */
import type { InstrumentKind } from '../music/tunings';
import { PlaythroughAnalyzer } from './analyzer';
import { grayFromRgba, type GrayImage } from './image';
import type { NeckModel } from './neck';

declare const self: DedicatedWorkerGlobalScope;

export type VisionRequest =
  | { type: 'init'; reference: GrayImage; model: NeckModel; instrument: InstrumentKind }
  | { type: 'frame'; time: number; bitmap: ImageBitmap }
  | { type: 'finish' };

let analyzer: PlaythroughAnalyzer | null = null;
let canvas: OffscreenCanvas | null = null;

function toGray(bitmap: ImageBitmap): GrayImage {
  if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  return grayFromRgba(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
}

self.onmessage = (e: MessageEvent<VisionRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      analyzer = new PlaythroughAnalyzer(msg.reference, msg.model, msg.instrument);
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'frame') {
      if (!analyzer) throw new Error('not initialised');
      analyzer.addFrame(msg.time, toGray(msg.bitmap));
      self.postMessage({ type: 'frameDone', time: msg.time });
    } else if (msg.type === 'finish') {
      if (!analyzer) throw new Error('not initialised');
      self.postMessage({ type: 'result', result: analyzer.finish() });
      analyzer = null;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
