// Download the instrument-separation model (HTDemucs 6-stem, ONNX) into models/ for the Node
// tests and the album benchmark. The app itself downloads it on first use instead.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import info from '../src/separation/modelInfo.json' with { type: 'json' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'models');
const target = path.join(dir, info.file);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (fs.existsSync(target) && fs.statSync(target).size === info.size && sha256(target) === info.sha256) {
  console.log(`${path.relative(root, target)} is already present and verified.`);
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
console.log(`Downloading ${info.name} (${(info.size / 1e6).toFixed(0)} MB)…`);
const res = await fetch(info.url);
if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
const tmp = `${target}.part`;
const out = fs.createWriteStream(tmp);
const hash = crypto.createHash('sha256');
let received = 0;
let lastPct = -1;
for await (const chunk of res.body) {
  hash.update(chunk);
  out.write(chunk);
  received += chunk.length;
  const pct = Math.floor((100 * received) / info.size);
  if (pct !== lastPct && pct % 10 === 0) {
    lastPct = pct;
    console.log(`  ${pct}%`);
  }
}
await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
const digest = hash.digest('hex');
if (received !== info.size || digest !== info.sha256) {
  fs.rmSync(tmp, { force: true });
  throw new Error(`Downloaded file does not match: ${received} bytes, sha256 ${digest}`);
}
fs.renameSync(tmp, target);
console.log(`Saved and verified ${path.relative(root, target)}.`);
