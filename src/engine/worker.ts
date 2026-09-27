/// <reference lib="webworker" />
/**
 * Web worker that owns the TensorFlow.js runtime and the Basic Pitch model, so the UI stays
 * responsive while a recording is analysed.
 */
import * as tf from '@tensorflow/tfjs-core';
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter';
import '@tensorflow/tfjs-backend-cpu';
import '@tensorflow/tfjs-backend-webgl';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import wasmUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url';
import wasmSimdUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url';
import wasmThreadedUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url';
import { Analyzer } from './analyzer';
import { WINDOW_SAMPLES, loadBasicPitchModel } from './basicPitch';
import type { WorkerRequest, WorkerResponse, BackendPreference } from './workerProtocol';

declare const self: DedicatedWorkerGlobalScope;

setWasmPaths({
  'tfjs-backend-wasm.wasm': wasmUrl,
  'tfjs-backend-wasm-simd.wasm': wasmSimdUrl,
  'tfjs-backend-wasm-threaded-simd.wasm': wasmThreadedUrl,
});

let analyzer: Analyzer | null = null;
let loadedFor: string | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

async function trySetBackend(name: string): Promise<boolean> {
  try {
    return await tf.setBackend(name);
  } catch {
    return false;
  }
}

/** A decaying two-note chord used to check a GPU backend against the reference (WASM) backend. */
function probeSignal(): Float32Array {
  const x = new Float32Array(WINDOW_SAMPLES);
  for (let i = 0; i < x.length; i++) {
    const t = i / 22050;
    const env = Math.exp(-3 * ((t * 2) % 1));
    x[i] = 0.3 * env * (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.4 * Math.sin(2 * Math.PI * 164.8 * t));
  }
  return x;
}

function runProbe(model: GraphModel, probe: Float32Array): Float32Array {
  return tf.tidy(() => {
    const out = model.execute(tf.tensor3d(probe, [1, WINDOW_SAMPLES, 1]), ['Identity_1']) as tf.Tensor;
    return out.dataSync() as Float32Array;
  });
}

async function prepare(pref: BackendPreference, modelUrl: string): Promise<Analyzer> {
  const key = `${pref}|${modelUrl}`;
  if (analyzer && loadedFor === key) return analyzer;

  const order: string[] =
    pref === 'webgl' ? ['webgl', 'wasm', 'cpu'] : pref === 'wasm' ? ['wasm', 'cpu'] : pref === 'cpu' ? ['cpu'] : ['webgl', 'wasm', 'cpu'];
  let backend = '';
  for (const name of order) {
    if (!(await trySetBackend(name))) continue;
    // In auto mode only accept a GPU that can render full-precision floats.
    if (name === 'webgl' && pref === 'auto' && !tf.env().getBool('WEBGL_RENDER_FLOAT32_CAPABLE')) continue;
    backend = name;
    break;
  }
  if (!backend) throw new Error('No TensorFlow.js backend is available on this device');

  const model = await loadBasicPitchModel(() => loadGraphModel(modelUrl));

  if (backend === 'webgl' && pref === 'auto') {
    // Some mobile GPUs are imprecise enough to change the result: verify against WASM.
    const probe = probeSignal();
    const gpu = runProbe(model, probe);
    if (await trySetBackend('wasm')) {
      const ref = runProbe(model, probe);
      let maxDiff = 0;
      for (let i = 0; i < ref.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ref[i] - gpu[i]));
      if (maxDiff < 0.05) await trySetBackend('webgl');
      else backend = 'wasm';
    }
  }
  analyzer = new Analyzer(model, backend);
  loadedFor = key;
  return analyzer;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const progress = (stage: string, fraction: number) => post({ type: 'progress', id: req.id, stage, fraction });
  try {
    if (req.type === 'analyze') {
      progress('Loading note-detection model', 0);
      const a = await prepare(req.backend, req.modelUrl);
      const analysis = await a.analyze(req.audio, req.sensitivity, progress);
      post({ type: 'result', id: req.id, analysis });
    } else if (req.type === 'redecode') {
      if (!analyzer) throw new Error('Nothing analysed yet');
      post({ type: 'result', id: req.id, analysis: analyzer.redecode(req.sensitivity, progress) });
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
