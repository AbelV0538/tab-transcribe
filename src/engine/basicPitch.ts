/*
 * Inference for Spotify's Basic Pitch model (https://github.com/spotify/basic-pitch),
 * a lightweight polyphonic note-transcription network. The model files in
 * public/models/basic-pitch are distributed under the Apache License 2.0.
 *
 * The windowing below follows basic-pitch-ts (src/inference.ts, Copyright 2022 Spotify AB,
 * Apache-2.0) but batches windows and keeps outputs in flat Float32Arrays so that
 * long recordings fit comfortably in memory on phones.
 */
import * as tf from '@tensorflow/tfjs-core';
import type { GraphModel } from '@tensorflow/tfjs-converter';

import { MODEL_SAMPLE_RATE } from './types';

export { MODEL_SAMPLE_RATE };
export const FFT_HOP = 256;
/** Samples per model window (2 s minus one hop). */
export const WINDOW_SAMPLES = MODEL_SAMPLE_RATE * 2 - FFT_HOP; // 43844
/** Model frames produced per window. */
export const FRAMES_PER_WINDOW = 172;
const OVERLAP_FRAMES = 30;
const HALF_OVERLAP_FRAMES = OVERLAP_FRAMES / 2;
const OVERLAP_SAMPLES = OVERLAP_FRAMES * FFT_HOP; // 7680
/** Hop between consecutive windows in samples. */
export const WINDOW_HOP = WINDOW_SAMPLES - OVERLAP_SAMPLES; // 36164
/** Frames kept from each window after trimming the overlap. */
export const KEPT_FRAMES = FRAMES_PER_WINDOW - OVERLAP_FRAMES; // 142
export const N_PITCHES = 88;
export const MIDI_OFFSET = 21;

const OUTPUT_FRAMES = 'Identity_1';
const OUTPUT_ONSETS = 'Identity_2';

/**
 * Small constant delay between the model's frame index and the physical onset
 * (basic-pitch uses 1.8 ms); calibrated in tests/model.test.ts.
 */
const FRAME_TIME_OFFSET = 0.0018;

/** Time in seconds of output frame `frame` (after overlap trimming and concatenation). */
export function frameToTime(frame: number): number {
  const window = Math.floor(frame / KEPT_FRAMES);
  const k = frame - window * KEPT_FRAMES;
  return (window * WINDOW_HOP + k * FFT_HOP) / MODEL_SAMPLE_RATE + FRAME_TIME_OFFSET;
}

/** Fractional frame index for a time in seconds (inverse of frameToTime). */
export function timeToFrame(time: number): number {
  const sample = Math.max(0, (time - FRAME_TIME_OFFSET) * MODEL_SAMPLE_RATE);
  const window = Math.floor(sample / WINDOW_HOP);
  const k = Math.min(KEPT_FRAMES - 1, (sample - window * WINDOW_HOP) / FFT_HOP);
  return window * KEPT_FRAMES + k;
}

/** Number of output frames that cover `nSamples` samples of audio. */
export function outputFrameCount(nSamples: number): number {
  const fullWindows = Math.floor(nSamples / WINDOW_HOP);
  const rest = nSamples - fullWindows * WINDOW_HOP;
  return fullWindows * KEPT_FRAMES + Math.min(KEPT_FRAMES, Math.ceil(rest / FFT_HOP));
}

/** Raw model activations, row-major `[frame][pitch]` with 88 pitches (MIDI 21..108). */
export interface ModelActivations {
  nFrames: number;
  frames: Float32Array;
  onsets: Float32Array;
}

export async function loadBasicPitchModel(
  loader: () => Promise<GraphModel>,
): Promise<GraphModel> {
  const model = await loader();
  // Warm-up run so shader compilation / wasm initialisation is not counted as progress.
  tf.tidy(() => {
    const out = model.execute(tf.zeros([1, WINDOW_SAMPLES, 1]), [OUTPUT_FRAMES]) as tf.Tensor;
    out.dataSync();
  });
  return model;
}

/**
 * Run the model over mono 22.05 kHz audio.
 * @param onProgress receives a fraction 0..1 after each batch.
 */
export async function runBasicPitch(
  model: GraphModel,
  audio: Float32Array,
  onProgress: (fraction: number) => void = () => {},
  batchSize = 4,
): Promise<ModelActivations> {
  const nFrames = outputFrameCount(audio.length);
  const nWindows = Math.max(1, Math.ceil(nFrames / KEPT_FRAMES));
  const frames = new Float32Array(nFrames * N_PITCHES);
  const onsets = new Float32Array(nFrames * N_PITCHES);

  for (let first = 0; first < nWindows; first += batchSize) {
    const count = Math.min(batchSize, nWindows - first);
    const input = new Float32Array(count * WINDOW_SAMPLES);
    for (let b = 0; b < count; b++) {
      // Window w starts OVERLAP_SAMPLES/2 before sample w * WINDOW_HOP (zero padding at the start).
      const srcStart = (first + b) * WINDOW_HOP - OVERLAP_SAMPLES / 2;
      const dstOffset = b * WINDOW_SAMPLES;
      const from = Math.max(0, srcStart);
      const to = Math.min(audio.length, srcStart + WINDOW_SAMPLES);
      if (to > from) input.set(audio.subarray(from, to), dstOffset + (from - srcStart));
    }

    const [frameTensor, onsetTensor] = tf.tidy(() => {
      const x = tf.tensor3d(input, [count, WINDOW_SAMPLES, 1]);
      return model.execute(x, [OUTPUT_FRAMES, OUTPUT_ONSETS]) as tf.Tensor[];
    });
    const [frameData, onsetData] = await Promise.all([frameTensor.data(), onsetTensor.data()]);
    frameTensor.dispose();
    onsetTensor.dispose();

    for (let b = 0; b < count; b++) {
      const outFrame0 = (first + b) * KEPT_FRAMES;
      for (let k = 0; k < KEPT_FRAMES; k++) {
        const outFrame = outFrame0 + k;
        if (outFrame >= nFrames) break;
        const src = (b * FRAMES_PER_WINDOW + k + HALF_OVERLAP_FRAMES) * N_PITCHES;
        frames.set(frameData.subarray(src, src + N_PITCHES) as Float32Array, outFrame * N_PITCHES);
        onsets.set(onsetData.subarray(src, src + N_PITCHES) as Float32Array, outFrame * N_PITCHES);
      }
    }
    onProgress(Math.min(1, (first + count) / nWindows));
    // Yield so progress messages get delivered.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { nFrames, frames, onsets };
}
