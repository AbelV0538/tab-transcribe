/**
 * Main-thread side of instrument separation. Each attempt runs in a fresh worker that is
 * terminated afterwards (see ./worker.ts). WebGPU is tried first; if it fails, for example
 * because the GPU runs out of memory, the separation is redone on the CPU.
 */
import type { StemName } from './demucs';
import { ensureModel } from './model';
import type { Provider } from './ortWeb';
import { webGpuAvailable } from './policy';
import type { SeparationRequest, SeparationResponse } from './protocol';

export interface SeparatedStems {
  /** Mono stems at the note model's rate (22.05 kHz). */
  stems: Partial<Record<StemName, Float32Array>>;
  provider: Provider;
  seconds: number;
}

export interface SeparateOptions {
  /** Try the GPU first (false when the user chose CPU processing). */
  allowGpu: boolean;
  onProgress: (stage: string, fraction: number) => void;
  /** Development aid: make the GPU attempt fail. */
  simulateGpuFailure?: boolean;
}

function runInWorker(req: SeparationRequest, onProgress: SeparateOptions['onProgress']): Promise<SeparatedStems> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const finish = () => worker.terminate();
    worker.onmessage = (e: MessageEvent<SeparationResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress(msg.stage, msg.fraction);
      else if (msg.type === 'result') {
        finish();
        resolve({ stems: msg.stems, provider: msg.provider, seconds: msg.seconds });
      } else {
        finish();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      finish();
      reject(new Error(e.message || 'the separation worker stopped (probably out of memory)'));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error('the separation result could not be received'));
    };
    // The stereo input is copied, not transferred: a retry needs it again.
    worker.postMessage(req);
  });
}

/** Separate stereo audio at 44.1 kHz. Rejects when every attempt failed. */
export async function separateStems(left: Float32Array, right: Float32Array, opts: SeparateOptions): Promise<SeparatedStems> {
  const model = await ensureModel(opts.onProgress);
  const providers: Provider[] = opts.allowGpu && webGpuAvailable() ? ['webgpu', 'wasm'] : ['wasm'];
  const errors: string[] = [];
  for (const provider of providers) {
    try {
      return await runInWorker(
        { left, right, provider, model: model ? model.slice(0) : null, simulateFailure: provider === 'webgpu' && opts.simulateGpuFailure },
        opts.onProgress,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[separate] ${provider} failed: ${message}`);
      errors.push(`${provider === 'webgpu' ? 'GPU' : 'CPU'}: ${message}`);
    }
  }
  throw new Error(errors.join('; '));
}
