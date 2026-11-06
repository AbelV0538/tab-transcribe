import type { StemName } from './demucs';
import type { Provider } from './ortWeb';

export type SeparationRequest = {
  /** Stereo at the model's rate (44.1 kHz). */
  left: Float32Array;
  right: Float32Array;
  provider: Provider;
  /** The model's bytes, or null to read them from Cache Storage. */
  model: ArrayBuffer | null;
  /** Development aid: fail the first segment, to exercise the fallbacks. */
  simulateFailure?: boolean;
};

export type SeparationResponse =
  | { type: 'progress'; stage: string; fraction: number }
  | {
      type: 'result';
      /** Mono stems at the note model's rate (22.05 kHz). */
      stems: Partial<Record<StemName, Float32Array>>;
      provider: Provider;
      seconds: number;
    }
  | { type: 'error'; message: string };
