// Renders public/icons/icon.svg into the PNG sizes needed by the web manifest and the
// Android launcher (run after changing the SVG): node scripts/generate-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'public/icons/icon.svg'), 'utf8');
const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();

async function render(out, size, { padding = 0, background = 'transparent', round = false } = {}) {
  const inner = size - 2 * padding;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:${background}">` +
      `<div style="width:${size}px;height:${size}px;display:grid;place-items:center;${round ? 'border-radius:50%;overflow:hidden;' : ''}">` +
      `<div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></div></body></html>`,
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: background === 'transparent' });
}

await render(path.join(root, 'public/icons/icon-192.png'), 192);
await render(path.join(root, 'public/icons/icon-512.png'), 512);
await render(path.join(root, 'public/icons/icon-maskable-512.png'), 512, { padding: 56, background: '#16181d' });

// Android launcher icons (only if the native project exists).
const res = path.join(root, 'android/app/src/main/res');
if (fs.existsSync(res)) {
  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, size] of Object.entries(densities)) {
    await render(path.join(res, `mipmap-${d}/ic_launcher.png`), size);
    await render(path.join(res, `mipmap-${d}/ic_launcher_round.png`), size, { round: true });
    // Adaptive icon foreground: 108dp canvas with the artwork in the central 72dp.
    const fg = Math.round((size * 108) / 48);
    await render(path.join(res, `mipmap-${d}/ic_launcher_foreground.png`), fg, { padding: Math.round(fg * 0.19) });
  }
  // Splash screens: icon centred on the app background, at each existing image's size.
  for (const dir of fs.readdirSync(res).filter((d) => d.startsWith('drawable'))) {
    const file = path.join(res, dir, 'splash.png');
    if (!fs.existsSync(file)) continue;
    const head = fs.readFileSync(file).subarray(16, 24);
    const w = head.readUInt32BE(0);
    const h = head.readUInt32BE(4);
    const icon = Math.round(Math.min(w, h) * 0.32);
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(
      `<html><body style="margin:0;background:#16181d;display:grid;place-items:center;width:${w}px;height:${h}px">` +
        svg.replace('<svg ', `<svg width="${icon}" height="${icon}" `) +
        '</body></html>',
    );
    await page.screenshot({ path: file });
  }
  const bg = path.join(res, 'values/ic_launcher_background.xml');
  if (fs.existsSync(bg)) {
    fs.writeFileSync(bg, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#16181D</color>\n</resources>\n');
  }
}
// iOS app icon (square, opaque: iOS applies its own mask) and splash.
const xcassets = path.join(root, 'ios/App/App/Assets.xcassets');
if (fs.existsSync(xcassets)) {
  const square = svg.replace('rx="112"', 'rx="0"');
  await page.setViewportSize({ width: 1024, height: 1024 });
  await page.setContent(`<html><body style="margin:0">${square.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`);
  await page.screenshot({ path: path.join(xcassets, 'AppIcon.appiconset/AppIcon-512@2x.png') });
  const splashDir = path.join(xcassets, 'Splash.imageset');
  await page.setViewportSize({ width: 2732, height: 2732 });
  await page.setContent(
    '<html><body style="margin:0;background:#16181d;display:grid;place-items:center;width:2732px;height:2732px">' +
      svg.replace('<svg ', '<svg width="640" height="640" ') +
      '</body></html>',
  );
  for (const f of fs.readdirSync(splashDir).filter((f) => f.endsWith('.png'))) await page.screenshot({ path: path.join(splashDir, f) });
}
await browser.close();
console.log('icons written');
