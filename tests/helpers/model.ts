/** Load and run the real Basic Pitch model in Node (WASM backend). */
import fs from 'node:fs';
import path from 'node:path';
import * as tf from '@tensorflow/tfjs-core';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import '@tensorflow/tfjs-backend-cpu';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { Analyzer } from '../../src/engine/analyzer';
import { loadBasicPitchModel } from '../../src/engine/basicPitch';

const root = path.resolve(__dirname, '../..');
let analyzer: Promise<Analyzer> | null = null;

export function getAnalyzer(): Promise<Analyzer> {
  if (!analyzer) {
    analyzer = (async () => {
      setWasmPaths(path.join(root, 'node_modules/@tensorflow/tfjs-backend-wasm/dist') + '/');
      const backend = (await tf.setBackend('wasm')) ? 'wasm' : 'cpu';
      if (backend === 'cpu') await tf.setBackend('cpu');
      await tf.ready();
      const dir = path.join(root, 'public/models/basic-pitch');
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
      const bin = fs.readFileSync(path.join(dir, 'group1-shard1of1.bin'));
      const weightData = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
      const model = await loadBasicPitchModel(() =>
        loadGraphModel(tf.io.fromMemory({ modelTopology: json.modelTopology, weightSpecs: json.weightsManifest[0].weights, weightData })),
      );
      return new Analyzer(model, backend);
    })();
  }
  return analyzer;
}
