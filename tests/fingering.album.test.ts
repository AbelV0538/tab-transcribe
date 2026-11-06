/**
 * Oracle fingering benchmark on the RTYWD album tabs (see tests/album/). Run with
 * `npm run test:album`. Skipped when the album files are absent.
 *
 * Writes tests/e2e/out/album-fingering.md (metrics only). With ALBUM_BASELINE=1 the results
 * are also saved as the baseline that later runs are compared with.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasAlbum, listSongs } from './album/dataset';
import { fix, pct, type PlayabilityStats } from './album/metrics';
import { runSong, summarise, type Summary, type TrackResult } from './album/oracle';

const OUT = path.resolve(__dirname, 'e2e/out');

function playRow(p: PlayabilityStats): string {
  return `${fix(p.shiftsPerMin, 1)} | ${fix(p.meanShift, 1)} | ${fix(p.fastJumpsPerMin, 2)} | ${p.overStretched} | ${fix(p.meanFret, 1)} | ${pct(p.openRate)}`;
}

function delta(now: number, before: number | undefined, asPct = true): string {
  if (before === undefined) return '';
  const d = now - before;
  return ` (${d >= 0 ? '+' : ''}${asPct ? (100 * d).toFixed(1) + ' pt' : d.toFixed(2)})`;
}

describe.skipIf(!hasAlbum())('oracle fingering on the RTYWD album tabs', () => {
  it('fingers the tabs’ notes like the tabs do', () => {
    const songs = listSongs();
    const results: TrackResult[] = songs.flatMap((s) => runSong(s));
    const perSong = songs.map((s) => ({ song: s.title, summary: summarise(results.filter((r) => r.song === s.title)) }));
    const total = summarise(results);

    const baselineFile = path.join(OUT, 'album-fingering-baseline.json');
    const baseline: { total: Summary; perSong: Array<{ song: string; summary: Summary }> } | null = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null;
    const before = (song: string) => baseline?.perSong.find((x) => x.song === song)?.summary;

    const md: string[] = ['# Oracle fingering benchmark (RTYWD)', ''];
    md.push(`Notes: ${total.notes} (scored ${total.scored}; tapped and harmonic notes are not scored)`, '');
    md.push(`**Exact string+fret accuracy: ${pct(total.accuracy)}${delta(total.accuracy, baseline?.total.accuracy)}**, per-song mean ${pct(total.songAccuracy)}${delta(total.songAccuracy, baseline?.total.songAccuracy)}`);
    md.push(`Tapped notes (not scored above): ${pct(total.tappedAccuracy)}`, '');
    const e = total.errors;
    md.push(`Errors: open→fretted ${e.openToFretted}, fretted→open ${e.frettedToOpen}, other string ${e.stringsApart.map((v, d) => `${d} apart: ${v ?? 0}`).filter((x) => !x.startsWith('0')).join(', ')}, dropped ${e.dropped}`, '');
    md.push('| Song | Notes | Accuracy | Shifts/min tab · model | Fast jumps/min tab · model | Open strings tab · model |', '| --- | --- | --- | --- | --- | --- |');
    for (const { song, summary: s } of perSong) {
      md.push(
        `| ${song} | ${s.scored} | ${pct(s.accuracy)}${delta(s.accuracy, before(song)?.accuracy)} | ${fix(s.tab.shiftsPerMin, 1)} · ${fix(s.model.shiftsPerMin, 1)} | ${fix(s.tab.fastJumpsPerMin)} · ${fix(s.model.fastJumpsPerMin)} | ${pct(s.tab.openRate)} · ${pct(s.model.openRate)} |`,
      );
    }
    md.push('', '## Playability (all tracks)', '', '| | Shifts/min | Mean shift (frets) | Fast jumps/min | Over-stretched shapes | Mean fret | Open strings |', '| --- | --- | --- | --- | --- | --- | --- |');
    md.push(`| Tab | ${playRow(total.tab)} |`, `| Model | ${playRow(total.model)} |`);
    if (baseline) md.push(`| Baseline model | ${playRow(baseline.total.model)} |`);

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'album-fingering.md'), md.join('\n') + '\n');
    const json = JSON.stringify({ total, perSong }, null, 1);
    fs.writeFileSync(path.join(OUT, 'album-fingering.json'), json);
    if (process.env.ALBUM_BASELINE) fs.writeFileSync(baselineFile, json);
    console.log(md.join('\n'));

    expect(total.scored).toBeGreaterThan(0);
    // The optimiser must never put two simultaneous notes on one string.
    expect(total.model.stringCollisions).toBe(0);
  });
});
