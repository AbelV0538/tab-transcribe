/**
 * Browser end-to-end test of the production build (run `npm run build` first, then
 * `npm run test:e2e`). Serves dist/, uploads synthesised audio and a synthesised video, and
 * checks detection, tab rendering, playback cursor and exports. Screenshots go to tests/e2e/out.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fretSpacePoint, renderFretboard, type FretboardPose } from './helpers/fretboard';
import { bassSong, encodeWav, guitarMelodySong, synthesize, type SynthNote } from './helpers/synth';

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'tests/e2e/out');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.webm': 'video/webm',
};

let server: http.Server;
let base = '';
let browser: Browser;

function serve(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = path.join(dist, decodeURIComponent(url.pathname));
    if (url.pathname.startsWith('/__fixtures/')) file = path.join(out, url.pathname.slice('/__fixtures/'.length));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
}

async function transcribe(page: Page, file: string) {
  await page.goto(base);
  await page.setInputFiles('#fileInput', file);
  await expect.poll(() => page.locator('#goBtn').isEnabled()).toBe(true);
  await page.click('#goBtn');
  await page.waitForSelector('#results:not([hidden])', { timeout: 180_000 });
  // Wait for the processing indicator to finish.
  await page.waitForSelector('#progress[hidden]', { state: 'attached', timeout: 60_000 });
}

beforeAll(async () => {
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Run `npm run build` before the e2e test');
  fs.mkdirSync(out, { recursive: true });
  const notes = [...bassSong(4), ...guitarMelodySong(4)];
  fs.writeFileSync(path.join(out, 'band.wav'), encodeWav(synthesize(notes, 9, 44100), 44100));
  fs.writeFileSync(path.join(out, 'bass.wav'), encodeWav(synthesize(bassSong(4), 9, 44100), 44100));
  await serve();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  browser = await chromium.launch({ executablePath, args: ['--autoplay-policy=no-user-gesture-required'] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe('web app', () => {
  it('transcribes a guitar + bass recording on a phone-sized screen', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await transcribe(page, path.join(out, 'band.wav'));

    const summary = await page.locator('#summary').innerText();
    expect(summary).toMatch(/Guitar/);
    expect(summary).toMatch(/Bass ·/);
    expect(summary).toMatch(/120 BPM/);
    // Guitar tab shown first; switch to bass.
    expect(await page.locator('#tabView').innerText()).toMatch(/^e\|/m);
    await page.getByRole('button', { name: 'Bass', exact: true }).click();
    const bassTab = await page.locator('#tabView').innerText();
    expect(bassTab).toMatch(/^E\|-0---0---3/m);
    await page.screenshot({ path: path.join(out, 'phone-bass.png'), fullPage: true });

    // Tap-to-seek moves the cursor.
    await page.locator('#tabView pre').first().click({ position: { x: 150, y: 20 } });
    await expect.poll(() => page.locator('.cursor[style*="block"]').count()).toBeGreaterThan(0);
    expect(await page.locator('#time').innerText()).not.toMatch(/^0:00 \//);

    // Exports.
    const [txt] = await Promise.all([page.waitForEvent('download'), page.click('#exportTxt')]);
    const text = fs.readFileSync(await txt.path(), 'utf8');
    expect(text).toMatch(/Guitar — tuning: Standard/);
    expect(text).toMatch(/Bass — tuning: Standard 4-string/);
    const [mid] = await Promise.all([page.waitForEvent('download'), page.click('#exportMidi')]);
    expect(fs.readFileSync(await mid.path()).subarray(0, 4).toString()).toBe('MThd');
    const [xml] = await Promise.all([page.waitForEvent('download'), page.click('#exportXml')]);
    const musicxml = fs.readFileSync(await xml.path(), 'utf8');
    expect(musicxml).toMatch(/<score-partwise version="4.0">/);
    expect(musicxml).toMatch(/<technical><string>\d<\/string><fret>\d+<\/fret><\/technical>/);

    // Piano roll (scrolls inside its card; the page must not become wider than the phone).
    await page.click('#rollCard summary');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(out, 'phone-roll.png'), fullPage: true });
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it('plays the transcription with a moving cursor', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await transcribe(page, path.join(out, 'bass.wav'));
    expect(await page.locator('#summary').innerText()).toMatch(/No guitar detected/);
    await page.getByRole('button', { name: 'Transcription' }).click();
    await page.click('#playBtn');
    await page.waitForTimeout(1500);
    const t = await page.locator('#time').innerText();
    expect(t).toMatch(/^0:0[1-2] \//);
    await page.click('#playBtn');
    await page.screenshot({ path: path.join(out, 'desktop-bass.png'), fullPage: true });
    await page.close();
  }, 300_000);

  it('decodes an MP4 with WebCodecs when the browser file decoder fails', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    // Simulate a browser whose decodeAudioData can't read the file.
    await page.addInitScript(() => {
      BaseAudioContext.prototype.decodeAudioData = function () {
        return Promise.reject(new DOMException('Unable to decode audio data', 'EncodingError'));
      };
    });
    await page.goto(base);
    const supported = await page.evaluate(async () =>
      typeof AudioDecoder !== 'undefined' && (await AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 1 })).supported === true,
    );
    if (!supported) {
      console.warn('Skipping: this browser build has no WebCodecs AAC decoder');
      await page.close();
      return;
    }
    await transcribe(page, path.join(root, 'tests/fixtures/bass-aac.mp4'));
    expect(logs.some((l) => l.startsWith('[decode] WebCodecs (AAC-LC)'))).toBe(true);
    expect(await page.locator('#summary').innerText()).toMatch(/No guitar detected[\s\S]*Bass ·/);
    expect(await page.locator('#tabView').innerText()).toMatch(/^E\|-0---0---3/m);
    await page.close();
  }, 300_000);

  it('explains when an audio track decodes to silence or is missing', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base);
    for (const [file, message] of [
      ['silent-aac.mp4', /No sound could be decoded from this file's audio track \(AAC-LC, 44\.1 kHz\)/],
      ['video-only.mp4', /This video has no audio track/],
    ] as const) {
      await page.setInputFiles('#fileInput', path.join(root, 'tests/fixtures', file));
      await page.click('#goBtn');
      await page.waitForSelector('#error:not([hidden])', { timeout: 60_000 });
      expect(await page.locator('#error').innerText()).toMatch(message);
      expect(await page.locator('#results').isHidden()).toBe(true);
    }
    await page.close();
  }, 300_000);

  it('corrects the tab with a playthrough video', async () => {
    // A bass line that fits both open position and 5th position, filmed with the fretting hand
    // held over frets 5-8.
    const pitches = [38, 40, 42, 43, 45, 43, 42, 40];
    const line: SynthNote[] = [...pitches, ...pitches].map((p, i) => ({ pitch: p, start: 0.5 + i * 0.5, end: 0.95 + i * 0.5, instrument: 'bass' }));
    fs.writeFileSync(path.join(out, 'playthrough.wav'), encodeWav(synthesize(line, 9, 44100), 44100));
    const pose: FretboardPose = { nutX: -120, nutY: 250, angle: 22, scale: 900 };
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    const videoLog: string[] = [];
    page.on('console', (m) => m.text().startsWith('[video]') && videoLog.push(m.text()));
    await page.goto(base);
    const b64 = await page.evaluate(
      async ({ src, pose, wavUrl }) => {
        const render = new Function(`return (${src})`)() as (w: number, h: number, p: unknown, hand: unknown) => Float32Array;
        const W = 360;
        const H = 640;
        // A few frames with slightly different hand shapes, and one with the hand lifted off.
        const images = [0, 1, 2, 3].map((k) => {
          const g = render(W, H, pose, k === 3 ? null : { from: 4.6 + 0.1 * k, to: 8.8 - 0.1 * k });
          const img = new ImageData(W, H);
          for (let i = 0; i < g.length; i++) img.data.set([g[i], g[i], g[i], 255], i * 4);
          return img;
        });
        const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
        const ctx2d = canvas.getContext('2d')!;
        ctx2d.putImageData(images[0], 0, 0);
        const ac = new AudioContext();
        const buf = await ac.decodeAudioData(await (await fetch(wavUrl)).arrayBuffer());
        const dest = ac.createMediaStreamDestination();
        const srcNode = ac.createBufferSource();
        srcNode.buffer = buf;
        srcNode.connect(dest);
        const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 2_500_000 });
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        const stopped = new Promise((r) => (rec.onstop = r));
        // Notes start every 0.5 s from 0.5 s; the hand lifts off between every other pair of notes.
        const t0 = performance.now();
        let k = 0;
        const timer = setInterval(() => {
          const t = (performance.now() - t0) / 1000;
          const lifted = t % 1 > 0.7 && t % 1 < 0.92;
          ctx2d.putImageData(images[lifted ? 3 : k++ % 3], 0, 0);
        }, 20);
        rec.start(250);
        srcNode.start();
        await new Promise((r) => setTimeout(r, buf.duration * 1000 + 300));
        rec.stop();
        await stopped;
        clearInterval(timer);
        const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      },
      { src: renderFretboard.toString(), pose, wavUrl: `${base}__fixtures/playthrough.wav` },
    );
    const video = path.join(out, 'playthrough.webm');
    fs.writeFileSync(video, Buffer.from(b64, 'base64'));

    const bassTab = async () => {
      if (await page.getByRole('button', { name: 'Bass', exact: true }).count()) await page.getByRole('button', { name: 'Bass', exact: true }).click();
      const text = await page.locator('#tabView').innerText();
      return text
        .split('\n')
        .filter((l) => /^[GDAE]\s*\|/.test(l))
        .flatMap((l) => (l.split('|').slice(1).join('|').match(/\d+/g) ?? []).map(Number));
    };

    // Without the video: the optimiser's own choice.
    await transcribe(page, video);
    const plain = await bassTab();
    expect(plain.length).toBeGreaterThan(8);

    // With the video: switch on, mark frets 5 and 12, transcribe again.
    await page.check('#playthrough');
    const canvas = page.locator('#calib canvas');
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0, { timeout: 20_000 }).toBeGreaterThan(50);
    await page.waitForTimeout(300);
    for (const fret of [5, 12]) {
      const box = (await canvas.boundingBox())!;
      const [x, y] = fretSpacePoint(pose, fret);
      await page.mouse.click(box.x + (x / 360) * box.width, box.y + (y / 640) * box.height);
    }
    await expect.poll(() => page.locator('.calib-status').innerText()).toMatch(/blue lines/);
    await page.screenshot({ path: path.join(out, 'calibration.png'), fullPage: true });
    await page.click('#goBtn');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#goBtn')!.disabled, null, { timeout: 180_000 });
    expect(problems).toEqual([]);
    expect(await page.locator('#error').isHidden()).toBe(true);
    const summary = await page.locator('#summary').innerText();
    expect(summary, summary + videoLog.join(' ')).toMatch(/Video: hand position used for (9\d|100)% of bass notes/);
    const filmed = await bassTab();
    // Without the video the line is fingered in open position (frets 0-4). With it, every fretted
    // note sits under the filmed hand (frets 5-8, plus a fret of slack each side); open strings are
    // still fine, a player in 5th position uses them too.
    const detail = JSON.stringify({ plain, filmed, summary });
    expect(Math.max(...plain), detail).toBeLessThanOrEqual(4);
    const fretted = filmed.filter((f) => f > 0);
    expect(fretted.every((f) => f >= 4 && f <= 10), detail).toBe(true);
    expect(fretted.filter((f) => f >= 7).length, detail).toBeGreaterThanOrEqual(4);
    // The neck overlay is drawn over the video.
    expect(await page.locator('#mediaBox canvas.neck-overlay').count()).toBe(1);
    await page.click('#playBtn');
    await page.waitForTimeout(800);
    await page.click('#playBtn');
    await page.screenshot({ path: path.join(out, 'playthrough.png'), fullPage: true });
    await page.close();
  }, 300_000);

  it('accepts a video file', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base);
    // Record a WebM video (canvas animation + the synthesised band audio) inside the browser.
    const b64 = await page.evaluate(async (wavUrl) => {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await (await fetch(wavUrl)).arrayBuffer());
      const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
      const g = canvas.getContext('2d')!;
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((r) => (rec.onstop = r));
      let frame = 0;
      const timer = setInterval(() => {
        g.fillStyle = `hsl(${frame++ * 3 % 360} 60% 40%)`;
        g.fillRect(0, 0, 320, 240);
      }, 33);
      rec.start(250);
      src.start();
      await new Promise((r) => setTimeout(r, buf.duration * 1000 + 300));
      rec.stop();
      await done;
      clearInterval(timer);
      const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, `${base}__fixtures/band.wav`);
    const video = path.join(out, 'band.webm');
    fs.writeFileSync(video, Buffer.from(b64, 'base64'));
    await transcribe(page, video);
    expect(await page.locator('#mediaBox video').count()).toBe(1);
    const summary = await page.locator('#summary').innerText();
    expect(summary).toMatch(/Guitar/);
    expect(summary).toMatch(/Bass ·/);
    await page.screenshot({ path: path.join(out, 'desktop-video.png'), fullPage: true });
    await page.close();
  }, 300_000);
});
