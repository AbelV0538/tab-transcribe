/**
 * Instrument separation in Node: the same `separate()` as the app, with ONNX Runtime Node
 * running the model from models/ (fetch it with `npm run models:separation`).
 */
import fs from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';
import { halveRate } from '../../src/audio/resample';
import { SEGMENT, separate, type StemModel, type StemName } from '../../src/separation/demucs';
import info from '../../src/separation/modelInfo.json';
import { KEPT_STEMS } from '../../src/separation/stems';

export const SEPARATION_MODEL_FILE = path.resolve(__dirname, '../../models', info.file);

export function hasSeparationModel(): boolean {
  return fs.existsSync(SEPARATION_MODEL_FILE) && fs.statSync(SEPARATION_MODEL_FILE).size === info.size;
}

let session: Promise<ort.InferenceSession> | null = null;

export async function nodeStemModel(): Promise<StemModel> {
  // Without the memory arena the peak stays around 600 MB instead of 2.7 GB.
  session ??= ort.InferenceSession.create(SEPARATION_MODEL_FILE, { enableCpuMemArena: false, enableMemPattern: false });
  const s = await session;
  return {
    run: async (x) => (await s.run({ [info.input]: new ort.Tensor('float32', x, [1, 2, SEGMENT]) }))[info.output].data as Float32Array,
  };
}

/** Separate stereo audio at 44.1 kHz (by default into the app's kept stems), as mono at 22.05 kHz. */
export async function separateInNode(
  left: Float32Array,
  right: Float32Array,
  onProgress?: (f: number) => void,
  wanted: readonly StemName[] = KEPT_STEMS,
): Promise<Partial<Record<StemName, Float32Array>>> {
  const stems = await separate(left, right, await nodeStemModel(), wanted, onProgress);
  const out: Partial<Record<StemName, Float32Array>> = {};
  for (const name of wanted) out[name] = halveRate(stems[name]!);
  return out;
}
