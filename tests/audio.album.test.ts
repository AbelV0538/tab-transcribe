/**
 * End-to-end benchmark on the RTYWD album: recording → note model → interpret() → guitar tab,
 * scored against every guitar track of the song's tab (two guitarists play, and the app writes
 * one guitar part). Run with `npm run test:album`; needs ffmpeg and the album files. The model's
 * output is cached in .album-cache/, so only the first run is slow.
 *
 * Writes tests/e2e/out/album-audio.md (metrics only). With ALBUM_BASELINE=1 the results are also
 * saved as the baseline that later runs are compared with.
 *
 * When the instrument-separation model is present (`npm run models:separation`), every song is
 * also transcribed from its separated stems ("separated" configurations; the stems are cached in
 * .album-cache/stems/). ALBUM_SEPARATION_SWEEP=1 additionally compares which stems count as guitar
 * and how strongly the stem decides the instrument (tests/e2e/out/album-separation-sweep.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_STEM_SHARE, STEM_PRIOR } from '../src/music/instruments';
import { DEFAULT_SETTINGS } from '../src/music/interpret';
import type { StemName } from '../src/separation/demucs';
import { GUITAR_STEMS } from '../src/separation/stems';
import { hasFfmpeg } from './album/analysis';
import { hasAlbum, listSongs } from './album/dataset';
import { fix, pct, playability, sumPlayability, type PlayabilityStats } from './album/metrics';
import { prepareRecording, scoreGuitar, withSeparation, type AudioResult, type PreparedRecording } from './album/recording';
import { hasSeparationModel } from './helpers/separation';

const OUT = path.resolve(__dirname, 'e2e/out');
const SEPARATE = hasSeparationModel();
const SWEEP = SEPARATE && !!process.env.ALBUM_SEPARATION_SWEEP;
// Guitar + other scored lower than the guitar stem alone (29.6 % vs 28.1 % guitar F1), so the
// sweep now only covers GUITAR_STEMS; add ['guitar', 'other'] back to compare again.
const GUITAR_STEM_CHOICES: Array<StemName[] | undefined> = [undefined];
const STEM_PRIORS = [2, STEM_PRIOR, 6];
const MIN_STEM_SHARES = [0, 0.05, MIN_STEM_SHARE, 0.2, 0.3];

interface SweepRow {
  guitarStems: string;
  stemPrior: number;
  minStemShare: number;
  results: AudioResult[];
}

describe.skipIf(!hasAlbum() || !hasFfmpeg())('end-to-end on the RTYWD album recordings', () => {
  it('transcribes the album', async () => {
    const results: AudioResult[] = [];
    const tabPlay: PlayabilityStats[] = [];
    const sweep: SweepRow[] = [];
    if (!SEPARATE) console.log('No separation model in models/ (npm run models:separation): only the full-mix configurations run.');
    for (const song of listSongs()) {
      if (!song.audioFile) {
        console.log(`${song.title}: no recording, skipped`);
        continue;
      }
      const rec = await prepareRecording(song);
      for (const t of rec.tabs.tracks) {
        const map = rec.alignment.map;
        if (t.notes.length) tabPlay.push(playability(t.notes.filter((n) => !n.harmonic).map((n) => ({ ...n, start: map(n.start), end: map(n.end) }))));
      }
      results.push(scoreGuitar(rec, DEFAULT_SETTINGS, 'default'));
      if (rec.tabTuningId) results.push(scoreGuitar(rec, { ...DEFAULT_SETTINGS, guitarTuning: rec.tabTuningId }, 'tab tuning'));
      if (!SEPARATE) continue;
      const sep = await withSeparation(rec, {});
      results.push(scoreGuitar(sep, DEFAULT_SETTINGS, 'separated'));
      if (rec.tabTuningId) results.push(scoreGuitar(sep, { ...DEFAULT_SETTINGS, guitarTuning: rec.tabTuningId }, 'separated, tab tuning'));
      if (SWEEP) await sweepSong(rec, sweep);
    }

    const baselineFile = path.join(OUT, 'album-audio-baseline.json');
    const baseline: AudioResult[] | null = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null;
    const prior = (r: AudioResult) => baseline?.find((b) => b.song === r.song && b.config === r.config);
    const d = (now: number | null, before: number | null | undefined) => (now === null || before === null || before === undefined ? '' : ` (${now - before >= 0 ? '+' : ''}${(100 * (now - before)).toFixed(1)})`);

    const md: string[] = ['# End-to-end benchmark (RTYWD recordings)', ''];
    md.push('Reference: every guitar track of the tab (both guitarists), aligned to the recording. Notes match on exact pitch within 50 ms. Changes in brackets are against the saved baseline.', '');
    const titles: Record<string, string> = {
      default: 'Default settings (full mix)',
      'tab tuning': 'Guitar tuning set to the tab’s tuning (full mix)',
      separated: `Separated instruments first (guitar = ${GUITAR_STEMS.join(' + ')} stem, or guitar + other + piano when the guitar stem is nearly empty)`,
      'separated, tab tuning': 'Separated instruments first, guitar tuning set to the tab’s tuning',
    };
    for (const config of Object.keys(titles)) {
      const rs = results.filter((r) => r.config === config);
      if (!rs.length) continue;
      md.push(`## ${titles[config]}`, '');
      md.push('| Song | Aligned | Raw notes F1 | Guitar notes | Guitar P / R | Guitar F1 | Octave-free F1 | Fret agreement | Dropped | Fast jumps/min | Tempo tab · app | Tuning |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const r of rs) {
        const b = prior(r);
        md.push(
          `| ${r.song} | ${pct(r.alignment)} | ${pct(r.raw.f1)} | ${r.guitar.notes} | ${pct(r.guitar.precision)} / ${pct(r.guitar.recall)} | ${pct(r.guitar.f1)}${d(r.guitar.f1, b?.guitar.f1)} | ${pct(r.guitar.octaveFreeF1)} | ${r.fretAgreement === null ? '–' : pct(r.fretAgreement) + d(r.fretAgreement, b?.fretAgreement)} | ${r.dropped} | ${fix(r.play.fastJumpsPerMin)}${b ? ` (${fix(b.play.fastJumpsPerMin)})` : ''} | ${fix(r.tabBpm, 1)} · ${fix(r.bpm, 1)} | ${r.tuning} |`,
        );
      }
      const mean = (f: (r: AudioResult) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
      const fa = rs.filter((r) => r.fretAgreement !== null);
      const bs = rs.map(prior).filter((x): x is AudioResult => !!x);
      const bmean = (f: (r: AudioResult) => number) => (bs.length === rs.length ? bs.reduce((s, r) => s + f(r), 0) / bs.length : undefined);
      const bfa = bs.filter((r) => r.fretAgreement !== null);
      const play = sumPlayability(rs.map((r) => r.play));
      const bplay = bs.length ? sumPlayability(bs.map((r) => r.play)) : null;
      md.push('');
      md.push(`- Mean guitar F1 **${pct(mean((r) => r.guitar.f1))}**${d(mean((r) => r.guitar.f1), bmean((r) => r.guitar.f1))} (precision ${pct(mean((r) => r.guitar.precision))}, recall ${pct(mean((r) => r.guitar.recall))}); raw detections F1 ${pct(mean((r) => r.raw.f1))}`);
      if (fa.length) md.push(`- Fret agreement on matched notes **${pct(fa.reduce((s, r) => s + r.fretAgreement!, 0) / fa.length)}**${bfa.length === fa.length ? d(fa.reduce((s, r) => s + r.fretAgreement!, 0) / fa.length, bfa.reduce((s, r) => s + r.fretAgreement!, 0) / bfa.length) : ''} over ${fa.length} songs with matching tunings`);
      md.push(`- Playability: ${fix(play.shiftsPerMin, 1)} shifts/min (mean ${fix(play.meanShift, 1)} frets), **${fix(play.fastJumpsPerMin)} fast jumps/min**${bplay ? ` (baseline ${fix(bplay.fastJumpsPerMin)})` : ''}, ${play.overStretched} over-stretched shapes${bplay ? ` (baseline ${bplay.overStretched})` : ''}, mean fret ${fix(play.meanFret, 1)}, open strings ${pct(play.openRate)}${bplay ? ` (baseline ${pct(bplay.openRate)})` : ''}`);
      md.push(`- Tempo within 3%: ${rs.filter((r) => [1, 2, 0.5].some((k) => Math.abs((k * r.bpm) / r.tabBpm - 1) < 0.03)).length}/${rs.length} (allowing half/double)`, '');
    }
    const comparison = compareConfigs(results, 'default', 'separated');
    if (comparison.length) md.push('## Separated vs full mix (default settings)', '', ...comparison, '');
    const tp = sumPlayability(tabPlay);
    md.push(`For reference, each tab track on its own: ${fix(tp.shiftsPerMin, 1)} shifts/min, ${fix(tp.fastJumpsPerMin)} fast jumps/min, ${tp.overStretched} over-stretched shapes, mean fret ${fix(tp.meanFret, 1)}, open strings ${pct(tp.openRate)}.`);

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'album-audio.md'), md.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'album-audio.json'), JSON.stringify(results, null, 1));
    if (process.env.ALBUM_BASELINE) fs.writeFileSync(baselineFile, JSON.stringify(results, null, 1));
    console.log(md.join('\n'));
    if (SWEEP) {
      const sw = sweepReport(sweep);
      fs.writeFileSync(path.join(OUT, 'album-separation-sweep.md'), sw.join('\n') + '\n');
      console.log(sw.join('\n'));
    }
    expect(results.length).toBeGreaterThan(0);
  });
});

/** Every combination of guitar stems, stem prior and minimum stem share, on one song (default settings). */
async function sweepSong(rec: PreparedRecording, rows: SweepRow[]) {
  for (const stems of GUITAR_STEM_CHOICES) {
    const sep = await withSeparation(rec, { guitarStems: stems });
    for (const prior of STEM_PRIORS) {
      for (const share of MIN_STEM_SHARES) {
        const key = stems?.join(' + ') ?? 'auto';
        let row = rows.find((r) => r.guitarStems === key && r.stemPrior === prior && r.minStemShare === share);
        if (!row) rows.push((row = { guitarStems: key, stemPrior: prior, minStemShare: share, results: [] }));
        row.results.push(scoreGuitar(sep, DEFAULT_SETTINGS, `sweep ${key} ${prior} ${share}`, { stemPrior: prior, minStemShare: share }));
      }
    }
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function sweepReport(rows: SweepRow[]): string[] {
  const md = [
    '# Separation sweep (default settings, mean over songs)',
    '',
    '| Guitar stems | Stem prior | Min stem share | Guitar F1 | Precision | Recall | Octave-free F1 | Fret agreement | Raw F1 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const fa = r.results.filter((x) => x.fretAgreement !== null).map((x) => x.fretAgreement!);
    md.push(
      `| ${r.guitarStems} | ${r.stemPrior} | ${r.minStemShare} | ${pct(mean(r.results.map((x) => x.guitar.f1)))} | ${pct(mean(r.results.map((x) => x.guitar.precision)))} | ${pct(mean(r.results.map((x) => x.guitar.recall)))} | ${pct(mean(r.results.map((x) => x.guitar.octaveFreeF1)))} | ${fa.length ? pct(mean(fa)) : '–'} | ${pct(mean(r.results.map((x) => x.raw.f1)))} |`,
    );
  }
  return md;
}

/** Per-song and mean change of the key metrics from config `a` to config `b`. */
function compareConfigs(results: AudioResult[], a: string, b: string): string[] {
  const pairs = results
    .filter((r) => r.config === b)
    .map((rb) => [results.find((ra) => ra.config === a && ra.song === rb.song), rb] as const)
    .filter((p): p is readonly [AudioResult, AudioResult] => !!p[0]);
  if (!pairs.length) return [];
  const pp = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}`;
  const md = ['| Song | Guitar F1 | Precision | Recall | Fret agreement | Raw F1 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const [ra, rb] of pairs) {
    const fa = ra.fretAgreement !== null && rb.fretAgreement !== null ? `${pct(rb.fretAgreement)} (${pp(rb.fretAgreement - ra.fretAgreement)})` : '–';
    md.push(
      `| ${rb.song} | ${pct(rb.guitar.f1)} (${pp(rb.guitar.f1 - ra.guitar.f1)}) | ${pct(rb.guitar.precision)} (${pp(rb.guitar.precision - ra.guitar.precision)}) | ${pct(rb.guitar.recall)} (${pp(rb.guitar.recall - ra.guitar.recall)}) | ${fa} | ${pct(rb.raw.f1)} (${pp(rb.raw.f1 - ra.raw.f1)}) |`,
    );
  }
  const d = (f: (r: AudioResult) => number) => pp(mean(pairs.map(([ra, rb]) => f(rb) - f(ra))));
  md.push('', `- Mean change: guitar F1 **${d((r) => r.guitar.f1)}** points (precision ${d((r) => r.guitar.precision)}, recall ${d((r) => r.guitar.recall)}), raw detections F1 ${d((r) => r.raw.f1)}`);
  return md;
}
