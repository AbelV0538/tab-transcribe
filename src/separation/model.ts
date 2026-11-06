/**
 * Getting the separation model onto the device: downloaded once from a pinned revision,
 * checked against its SHA-256 and kept in Cache Storage. Only the model is downloaded;
 * recordings never leave the device.
 */
import info from './modelInfo.json';

export const MODEL_INFO = info;
const CACHE_NAME = 'tab-transcribe-models-v1';
const MB = 1e6;

/** Where the model is fetched from (overridable for development and tests). */
export function modelUrl(): string {
  const override = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_SEPARATION_MODEL_URL;
  return override || info.url;
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Bytes kept in memory when Cache Storage is unavailable (re-downloaded in each session). */
let inMemory: ArrayBuffer | null = null;

/**
 * Make sure the model is available. Resolves to `null` when it is in Cache Storage (the
 * separation worker reads it from there), or to the model's bytes when it can't be cached.
 */
export async function ensureModel(onProgress: (stage: string, fraction: number) => void): Promise<ArrayBuffer | null> {
  const url = modelUrl();
  const pinned = url === info.url;
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit && (!pinned || hit.headers.get('x-sha256') === info.sha256)) return null;
  }
  if (inMemory) return inMemory;

  const stage = `Downloading instrument-separation model (${Math.round(info.size / MB)} MB, once)`;
  onProgress(stage, 0);
  let res: Response;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  } catch {
    throw new Error('Could not download the instrument-separation model. Check the internet connection (it is needed once).');
  }
  if (!res.ok || !res.body) throw new Error(`Could not download the instrument-separation model (HTTP ${res.status}).`);
  const expected = pinned ? info.size : Number(res.headers.get('content-length')) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (expected) onProgress(stage, Math.min(1, received / expected));
  }
  const bytes = new Uint8Array(received);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  chunks.length = 0;
  if (pinned) {
    onProgress('Checking the instrument-separation model', 1);
    if (received !== info.size || (await sha256Hex(bytes)) !== info.sha256) {
      throw new Error('The downloaded instrument-separation model is damaged (checksum mismatch). Try again.');
    }
  }

  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'x-sha256': pinned ? info.sha256 : '' } }));
      // Ask the browser not to evict it under storage pressure (best effort).
      void (navigator.storage?.persist?.() ?? Promise.resolve()).catch(() => {});
      return null;
    } catch (err) {
      console.warn('[separate] could not cache the model; it will be downloaded again next session', err);
    }
  }
  inMemory = bytes.buffer;
  return inMemory;
}

/** Read the cached model (inside the separation worker). */
export async function readCachedModel(): Promise<ArrayBuffer> {
  const cache = await openCache();
  const hit = await cache?.match(modelUrl());
  if (!hit) throw new Error('The instrument-separation model is not in the cache');
  return hit.arrayBuffer();
}
