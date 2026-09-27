/** Main-thread wrapper around the analysis worker. */
import type { AudioAnalysis, Sensitivity } from './types';
import type { BackendPreference, WorkerRequest, WorkerResponse } from './workerProtocol';

type Pending = {
  resolve: (a: AudioAnalysis) => void;
  reject: (e: Error) => void;
  onProgress?: (stage: string, fraction: number) => void;
};

export class EngineClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') p.onProgress?.(msg.stage, msg.fraction);
      else {
        this.pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.analysis);
        else p.reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'The analysis worker crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private request(msg: WorkerRequest, onProgress?: Pending['onProgress'], transfer: Transferable[] = []): Promise<AudioAnalysis> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject, onProgress });
      this.ensureWorker().postMessage(msg, transfer);
    });
  }

  analyze(
    audio: Float32Array,
    sensitivity: Sensitivity,
    backend: BackendPreference,
    onProgress?: (stage: string, fraction: number) => void,
  ): Promise<AudioAnalysis> {
    const modelUrl = new URL('models/basic-pitch/model.json', document.baseURI).href;
    // Send a copy: the caller keeps its buffer for playback/visualisation.
    const copy = new Float32Array(audio);
    return this.request({ type: 'analyze', id: this.nextId++, audio: copy, sensitivity, backend, modelUrl }, onProgress, [copy.buffer]);
  }

  redecode(sensitivity: Sensitivity, onProgress?: (stage: string, fraction: number) => void): Promise<AudioAnalysis> {
    return this.request({ type: 'redecode', id: this.nextId++, sensitivity }, onProgress);
  }
}
