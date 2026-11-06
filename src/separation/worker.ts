/// <reference lib="webworker" />
/**
 * Dedicated worker for instrument separation. It is terminated after each run: a WebAssembly
 * heap never shrinks, so ending the worker is the only way to hand the ~1 GB the network needs
 * back before the note model runs.
 */
import { halveRate } from '../audio/resample';
import { separate, type StemName } from './demucs';
import { readCachedModel } from './model';
import { createWebStemModel } from './ortWeb';
import type { SeparationRequest, SeparationResponse } from './protocol';
import { KEPT_STEMS } from './stems';

declare const self: DedicatedWorkerGlobalScope;

function post(msg: SeparationResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

/** " · about 4 min left", estimated from the segments done so far. */
function timeLeft(fraction: number, elapsed: number): string {
  if (fraction <= 0 || fraction >= 1) return '';
  const left = (elapsed * (1 - fraction)) / fraction;
  return left < 60 ? ' · less than a minute left' : ` · about ${Math.round(left / 60)} min left`;
}

function heapMb(): string {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? `, JS heap ${Math.round(mem.usedJSHeapSize / 1e6)} MB` : '';
}

self.onmessage = async (event: MessageEvent<SeparationRequest>) => {
  const req = event.data;
  try {
    const t0 = performance.now();
    post({ type: 'progress', stage: 'Loading instrument-separation model', fraction: 0 });
    const bytes = req.model ?? (await readCachedModel());
    const model = await createWebStemModel(bytes, req.provider);
    console.info(`[separate] ${req.provider}: model ready in ${((performance.now() - t0) / 1000).toFixed(1)} s${heapMb()}`);

    let segments = 0;
    let lastLog = performance.now();
    const t1 = performance.now();
    const stems = await separate(
      req.left,
      req.right,
      {
        run: async (x) => {
          if (req.simulateFailure) throw new Error('Simulated separation failure');
          const out = await model.run(x);
          segments++;
          if (segments === 1 || performance.now() - lastLog > 10_000) {
            lastLog = performance.now();
            console.info(`[separate] ${req.provider}: ${segments} segments, ${((performance.now() - t1) / segments / 1000).toFixed(2)} s each${heapMb()}`);
          }
          return out;
        },
      },
      KEPT_STEMS,
      (f) => post({ type: 'progress', stage: `Separating instruments${req.provider === 'wasm' ? ' on the CPU' : ''}${timeLeft(f, (performance.now() - t1) / 1000)}`, fraction: f }),
    );
    await model.release();

    const out: Partial<Record<StemName, Float32Array>> = {};
    for (const name of KEPT_STEMS) {
      const s = stems[name];
      if (s) out[name] = halveRate(s);
      delete stems[name];
    }
    const seconds = (performance.now() - t0) / 1000;
    console.info(`[separate] ${req.provider}: done in ${seconds.toFixed(1)} s (${segments} segments)`);
    post({ type: 'result', stems: out, provider: req.provider, seconds }, Object.values(out).map((s) => s.buffer));
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
