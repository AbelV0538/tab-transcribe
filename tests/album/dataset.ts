/**
 * The RTYWD album benchmark data: `RTYWD Guitar Tabs/[n] <Title>/…/*.gp` paired with
 * `RTYWD Audio/<Title>[ (feat. …)].mp3`. The files are copyrighted and git-ignored; every
 * benchmark skips when they are absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readGpFile, type GpSong } from './gp';

export const ROOT = path.resolve(__dirname, '../..');
export const TABS_DIR = path.join(ROOT, 'RTYWD Guitar Tabs');
export const AUDIO_DIR = path.join(ROOT, 'RTYWD Audio');

export interface AlbumSong {
  /** Track number on the album. */
  number: number;
  title: string;
  gpFile: string;
  /** Null when there is no recording for the song. */
  audioFile: string | null;
}

export function hasAlbum(): boolean {
  return fs.existsSync(TABS_DIR);
}

function findFile(dir: string, ext: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = findFile(p, ext);
      if (inner) return inner;
    } else if (entry.name.toLowerCase().endsWith(ext)) return p;
  }
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/\(feat\..*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function listSongs(): AlbumSong[] {
  if (!hasAlbum()) return [];
  const audio = fs.existsSync(AUDIO_DIR) ? fs.readdirSync(AUDIO_DIR).filter((f) => /\.(mp3|m4a|wav|flac|ogg)$/i.test(f)) : [];
  const songs: AlbumSong[] = [];
  for (const entry of fs.readdirSync(TABS_DIR, { withFileTypes: true })) {
    const m = entry.isDirectory() && /^\[(\d+)\]\s*(.+)$/.exec(entry.name);
    if (!m) continue;
    const gpFile = findFile(path.join(TABS_DIR, entry.name), '.gp');
    if (!gpFile) continue;
    const title = m[2].trim();
    const match = audio.find((f) => norm(path.parse(f).name) === norm(title));
    songs.push({ number: Number(m[1]), title, gpFile, audioFile: match ? path.join(AUDIO_DIR, match) : null });
  }
  return songs.sort((a, b) => a.number - b.number);
}

const cache = new Map<string, GpSong>();
export function loadTabs(song: AlbumSong): GpSong {
  let s = cache.get(song.gpFile);
  if (!s) {
    s = readGpFile(song.gpFile);
    cache.set(song.gpFile, s);
  }
  return s;
}
