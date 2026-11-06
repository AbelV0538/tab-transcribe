/**
 * Fit the guitar fingering weights to the album tabs (slow; run with ALBUM_TUNE=1
 * npm run test:album). Reports held-out accuracy from 3-fold cross-validation by song, then
 * fits on every song. The printed weights are meant to be copied into GUITAR_WEIGHTS.
 *
 * Then sweeps the note-drop cost (FingeringWeights.dropNote) on the recordings: how many fast
 * jumps it removes against what it costs in note accuracy and in the oracle benchmark.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUITAR_WEIGHTS, type FingeringWeights } from '../src/music/fingering';
import { DEFAULT_SETTINGS } from '../src/music/interpret';
import { hasFfmpeg } from './album/analysis';
import { hasAlbum, listSongs } from './album/dataset';
import { sumPlayability } from './album/metrics';
import { runSong, summarise } from './album/oracle';
import { prepareRecording, scoreGuitar } from './album/recording';
import { evaluate, fit, HAND_SET_WEIGHTS, passesGuards } from './album/tune';

const OUT = path.resolve(__dirname, 'e2e/out');

describe.skipIf(!hasAlbum() || !process.env.ALBUM_TUNE)('fit fingering weights to the album tabs', () => {
  it('cross-validates and fits', () => {
    const lines: string[] = ['# Fingering weight fit', ''];
    const log = (...ls: string[]) => {
      for (const l of ls) {
        lines.push(l);
        console.log(l);
      }
    };
    expect(passesGuards(HAND_SET_WEIGHTS)).toBe(true);
    expect(passesGuards({})).toBe(true);
    const songs = listSongs();
    const folds = [0, 1, 2].map((k) => songs.filter((_, i) => i % 3 === k));
    const heldOut: Array<{ before: number; after: number; n: number }> = [];
    const foldWeights: Array<Partial<FingeringWeights>> = [];
    folds.forEach((test, k) => {
      const train = songs.filter((s) => !test.includes(s));
      log(`## Fold ${k + 1}: held out ${test.map((s) => s.title).join(', ')}`);
      const { weights } = fit(train, HAND_SET_WEIGHTS, log);
      foldWeights.push(weights);
      const before = evaluate(test, HAND_SET_WEIGHTS).songAccuracy;
      const after = evaluate(test, weights).songAccuracy;
      log(`  held-out per-song accuracy: ${(100 * before).toFixed(2)}% → ${(100 * after).toFixed(2)}%`);
      heldOut.push({ before, after, n: test.length });
    });
    const mean = (f: (x: { before: number; after: number; n: number }) => number) => heldOut.reduce((s, x) => s + f(x) * x.n, 0) / songs.length;
    log('', `**Held-out mean per-song accuracy: ${(100 * mean((x) => x.before)).toFixed(2)}% → ${(100 * mean((x) => x.after)).toFixed(2)}%**`, '');

    // Coordinate descent depends on where it starts: fit on all songs from the hand-set weights
    // and from each fold's solution, and keep the best.
    let final = { weights: HAND_SET_WEIGHTS, score: -1 };
    for (const [i, start] of [HAND_SET_WEIGHTS, ...foldWeights].entries()) {
      log(`## Final fit on all songs, starting from ${i === 0 ? 'the hand-set weights' : `fold ${i}`}`);
      const f = fit(songs, start, log);
      if (f.score > final.score) final = f;
    }
    log(`Best final fit: ${(100 * final.score).toFixed(2)}%`);
    const merged: FingeringWeights = { ...GUITAR_WEIGHTS, ...final.weights };
    log('', '```json', JSON.stringify(merged, (_, v) => (v === -Infinity ? '-Infinity' : v === Infinity ? 'Infinity' : v), 2), '```');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'album-tune.md'), lines.join('\n') + '\n');
  });

  it.skipIf(!hasFfmpeg())('sweeps the note-drop cost', async () => {
    const recs = [];
    for (const song of listSongs()) if (song.audioFile) recs.push(await prepareRecording(song));
    const lines = ['# Note-drop cost sweep', '', '| dropNote | Guitar F1 | Precision | Recall | Fret agreement | Dropped | Fast jumps/min | Oracle accuracy |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
    const original = GUITAR_WEIGHTS.dropNote;
    try {
      for (const drop of [Infinity, 40, 25, 16, 10, 6]) {
        GUITAR_WEIGHTS.dropNote = drop;
        const rs = recs.map((r) => scoreGuitar(r, r.tabTuningId ? { ...DEFAULT_SETTINGS, guitarTuning: r.tabTuningId } : DEFAULT_SETTINGS, 'tab tuning'));
        const mean = (f: (x: (typeof rs)[number]) => number) => rs.reduce((s, x) => s + f(x), 0) / rs.length;
        const fa = rs.filter((r) => r.fretAgreement !== null);
        const oracle = summarise(listSongs().flatMap((s) => runSong(s)));
        const pct = (x: number) => `${(100 * x).toFixed(2)}%`;
        lines.push(
          `| ${drop} | ${pct(mean((r) => r.guitar.f1))} | ${pct(mean((r) => r.guitar.precision))} | ${pct(mean((r) => r.guitar.recall))} | ${pct(fa.reduce((s, r) => s + r.fretAgreement!, 0) / Math.max(1, fa.length))} | ${rs.reduce((s, r) => s + r.dropped, 0)} | ${sumPlayability(rs.map((r) => r.play)).fastJumpsPerMin.toFixed(2)} | ${pct(oracle.accuracy)} |`,
        );
        console.log(lines[lines.length - 1]);
      }
    } finally {
      GUITAR_WEIGHTS.dropNote = original;
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'album-drop-sweep.md'), lines.join('\n') + '\n');
  });
});
