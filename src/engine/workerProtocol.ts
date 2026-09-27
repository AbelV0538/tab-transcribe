import type { AudioAnalysis, Sensitivity } from './types';

export type BackendPreference = 'auto' | 'webgl' | 'wasm' | 'cpu';

export type WorkerRequest =
  | {
      type: 'analyze';
      id: number;
      /** Mono audio at 22.05 kHz. */
      audio: Float32Array;
      sensitivity: Sensitivity;
      backend: BackendPreference;
      modelUrl: string;
    }
  | { type: 'redecode'; id: number; sensitivity: Sensitivity };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string; fraction: number }
  | { type: 'result'; id: number; analysis: AudioAnalysis }
  | { type: 'error'; id: number; message: string };
