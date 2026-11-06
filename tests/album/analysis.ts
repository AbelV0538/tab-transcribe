/**
 * Recording → AudioAnalysis for the album benchmark, with an on-disk cache: running the note
 * model over a whole song takes minutes, re-interpreting the cached result takes milliseconds.
 * Recordings are decoded with ffmpeg (mono, 22.05 kHz, float).
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AudioAnalysis, RawNote, Sensitivity } from '../../src/engine/types';
import { MODEL_SAMPLE_RATE } from '../../src/engine/types';
import { SEPARATION_RATE, type StemName } from '../../src/separation/demucs';
import modelInfo from '../../src/separation/modelInfo.json';
import { instrumentStems } from '../../src/separation/stems';
import { getAnalyzer } from '../helpers/model';
import { separateInNode } from '../helpers/separation';
import { ROOT } from './dataset';

export const CACHE_DIR = path.join(ROOT, '.album-cache');

export function hasFfmpeg(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export function decodeAudio(file: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(MODEL_SAMPLE_RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${r.stderr?.toString()}`);
  const buf = r.stdout as Buffer;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Stereo at the separation model's rate (44.1 kHz). */
export function decodeStereo(file: string): { left: Float32Array; right: Float32Array } {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '2', '-ar', String(SEPARATION_RATE), '-f', 'f32le', '-'], { maxBuffer: 2 ** 31 });
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${r.stderr?.toString()}`);
  const buf = r.stdout as Buffer;
  const inter = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const n = inter.length >> 1;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = inter[2 * i];
    right[i] = inter[2 * i + 1];
  }
  return { left, right };
}

function hashFiles(h: crypto.Hash, dir: string, filter: (f: string) => boolean = () => true) {
  for (const f of fs.readdirSync(dir).sort()) if (filter(f)) h.update(fs.readFileSync(path.join(dir, f)));
}

/** Changes to the recording, the model or the analysis code invalidate the cache. */
function cacheKey(file: string, sensitivity: Sensitivity, separation?: string): string {
  const h = crypto.createHash('sha1');
  const st = fs.statSync(file);
  h.update(`${path.basename(file)}:${st.size}:${st.mtimeMs}:${sensitivity}`);
  h.update(fs.readFileSync(path.join(ROOT, 'public/models/basic-pitch/model.json')));
  hashFiles(h, path.join(ROOT, 'src/engine'));
  if (separation) h.update(`separated:${separation}:${stemsKey(file)}`);
  return h.digest('hex').slice(0, 16);
}

/** Key of a recording's separated stems: the recording, the separation model and code. */
function stemsKey(file: string): string {
  const h = crypto.createHash('sha1');
  const st = fs.statSync(file);
  h.update(`${path.basename(file)}:${st.size}:${st.mtimeMs}:${modelInfo.sha256}:${BENCHMARK_STEMS.join()}`);
  hashFiles(h, path.join(ROOT, 'src/separation'), (f) => f === 'demucs.ts');
  h.update(fs.readFileSync(path.join(ROOT, 'src/audio/resample.ts')));
  return h.digest('hex').slice(0, 16);
}

const STEMS_DIR = path.join(CACHE_DIR, 'stems');
/** The benchmark keeps "other" too, to compare guitar stem choices (see GUITAR_STEMS). */
const BENCHMARK_STEMS: readonly StemName[] = ['guitar', 'bass', 'other', 'piano'];

/** The recording's separated stems (mono, 22.05 kHz), computed once and cached as raw f32. */
export async function separatedStems(file: string): Promise<Partial<Record<StemName, Float32Array>>> {
  fs.mkdirSync(STEMS_DIR, { recursive: true });
  const slug = path.parse(file).name.replace(/[^A-Za-z0-9]+/g, '-');
  const key = stemsKey(file);
  const fileOf = (stem: string) => path.join(STEMS_DIR, `${slug}.${key}.${stem}.f32`);
  if (BENCHMARK_STEMS.every((s) => fs.existsSync(fileOf(s)))) {
    const out: Partial<Record<StemName, Float32Array>> = {};
    for (const s of BENCHMARK_STEMS) {
      const b = fs.readFileSync(fileOf(s));
      out[s] = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    }
    return out;
  }
  const { left, right } = decodeStereo(file);
  const t0 = performance.now();
  let last = 0;
  const stems = await separateInNode(
    left,
    right,
    (f) => {
      if (f - last >= 0.25 || f === 1) {
        last = f;
        console.log(`  separating ${path.basename(file)}: ${Math.round(100 * f)}%`);
      }
    },
    BENCHMARK_STEMS,
  );
  console.log(`  separated ${path.basename(file)} (${(left.length / SEPARATION_RATE).toFixed(0)} s) in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  for (const f of fs.readdirSync(STEMS_DIR)) if (f.startsWith(`${slug}.`)) fs.rmSync(path.join(STEMS_DIR, f));
  for (const s of BENCHMARK_STEMS) {
    const a = stems[s]!;
    fs.writeFileSync(fileOf(s), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  }
  return stems;
}

interface Cached {
  duration: number;
  notes: RawNote[];
  envelope: string;
  envelopeRate: number;
  tuningCents: number | null;
  backend: string;
  separated?: boolean;
}

export interface SeparationChoice {
  /** Stems transcribed as guitar; by default the app's automatic choice (see src/separation/stems.ts). */
  guitarStems?: readonly StemName[];
}

/**
 * Analyse a recording, from the full mix or, with `separation`, from its separated guitar
 * and bass stems (like the app does with "Separate instruments first").
 */
export async function analyseRecording(file: string, sensitivity: Sensitivity = 'normal', separation?: SeparationChoice): Promise<AudioAnalysis> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const variant = separation ? (separation.guitarStems?.join('+') ?? 'auto') : undefined;
  const slug = path.parse(file).name.replace(/[^A-Za-z0-9]+/g, '-') + (variant ? `.sep-${variant}` : '');
  const cacheFile = path.join(CACHE_DIR, `${slug}.${cacheKey(file, sensitivity, variant)}.json`);
  if (fs.existsSync(cacheFile)) {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Cached;
    const bytes = Buffer.from(c.envelope, 'base64');
    return {
      duration: c.duration,
      notes: c.notes,
      onsetEnvelope: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      envelopeRate: c.envelopeRate,
      tuningCents: c.tuningCents,
      backend: c.backend,
      ...(c.separated ? { separated: true } : {}),
    };
  }
  const audio = decodeAudio(file);
  const stems = separation ? instrumentStems(await separatedStems(file), separation.guitarStems) : undefined;
  if (stems && !separation?.guitarStems) console.log(`  ${path.basename(file)}: guitar transcribed from the ${stems.guitarFrom.join(' + ')} stem(s)`);
  const analyzer = await getAnalyzer();
  const a = await analyzer.analyze(audio, sensitivity, undefined, stems);
  const env = a.onsetEnvelope;
  const cached: Cached = {
    duration: a.duration,
    notes: a.notes,
    envelope: Buffer.from(env.buffer, env.byteOffset, env.byteLength).toString('base64'),
    envelopeRate: a.envelopeRate,
    tuningCents: a.tuningCents,
    backend: a.backend,
    separated: a.separated,
  };
  // Drop stale cache entries for this recording.
  const stale = (f: string) => f.startsWith(`${slug}.`) && /^[0-9a-f]{16}\.json$/.test(f.slice(slug.length + 1));
  for (const f of fs.readdirSync(CACHE_DIR)) if (stale(f)) fs.rmSync(path.join(CACHE_DIR, f));
  fs.writeFileSync(cacheFile, JSON.stringify(cached));
  return a;
}
