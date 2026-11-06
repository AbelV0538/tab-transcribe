/**
 * HTDemucs on ONNX Runtime Web: WebGPU when available, otherwise WebAssembly on the CPU.
 * Only loaded inside the separation worker (./worker.ts).
 */
// The default build: its WebGPU provider is the JavaScript one (JSEP). The newer native WebGPU
// build (`onnxruntime-web/webgpu`, "asyncify") lacks the ConstantOfShape kernel HTDemucs' iSTFT
// needs, so it can't load the model at all. One binary serves both WebGPU and WebAssembly.
import * as ort from 'onnxruntime-web';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import info from './modelInfo.json';
import { SEGMENT, type StemModel } from './demucs';

export type Provider = 'webgpu' | 'wasm';

export interface WebStemModel extends StemModel {
  readonly provider: Provider;
  release(): Promise<void>;
}

interface LosableDevice {
  lost: Promise<{ message?: string; reason?: string }>;
  adapterInfo?: { vendor?: string; architecture?: string; description?: string };
}

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// Threads need a cross-origin isolated page; otherwise ORT would warn and fall back anyway.
ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

export function webGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

export async function createWebStemModel(bytes: ArrayBuffer, provider: Provider): Promise<WebStemModel> {
  if (provider === 'webgpu') {
    if (!webGpuAvailable()) throw new Error('WebGPU is not available in this browser');
    // On laptops with two GPUs, prefer the dedicated one: it has its own memory, while the
    // integrated GPU would take the ~1 GB from system RAM. Only affects the first session.
    ort.env.webgpu.powerPreference = 'high-performance';
  }
  const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: [provider],
    // Higher levels constant-fold the fp16 → fp32 weight casts, which needs more than the 4 GB
    // a WebAssembly heap can have. The casts are cheap at run time.
    graphOptimizationLevel: 'disabled',
    // Don't keep a memory pool: peak memory matters more than allocation speed here.
    enableCpuMemArena: false,
    enableMemPattern: false,
  });

  let lost: string | null = null;
  if (provider === 'webgpu') {
    try {
      const device = (await ort.env.webgpu.device) as unknown as LosableDevice | undefined;
      const a = device?.adapterInfo;
      if (a) console.info(`[separate] webgpu adapter: ${[a.vendor, a.architecture, a.description].filter(Boolean).join(' ') || 'unknown'}`);
      void device?.lost.then((i) => {
        lost = `The GPU stopped responding (${i.message || i.reason || 'device lost'})`;
      });
    } catch {
      /* not exposed by this build: rely on run() failing instead */
    }
  }

  return {
    provider,
    async run(planarStereo: Float32Array): Promise<Float32Array> {
      if (lost) throw new Error(lost);
      const out = await session.run({ [info.input]: new ort.Tensor('float32', planarStereo, [1, 2, SEGMENT]) });
      const tensor = out[info.output];
      const data = tensor.data as Float32Array;
      if (lost) throw new Error(lost);
      return data;
    },
    release: () => session.release(),
  };
}
