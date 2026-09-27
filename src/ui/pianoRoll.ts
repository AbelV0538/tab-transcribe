/** Piano-roll canvas of everything the model heard, coloured by the instrument it was assigned to. */
import type { AudioAnalysis } from '../engine/types';
import type { Transcription } from '../music/interpret';
import { slotToTime, slotsPerBar } from '../music/rhythm';
import { noteName } from '../music/theory';

const PX_PER_SEC = 70;
const ROW = 5;
const GUTTER = 34;

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || '#888';
}

export class PianoRoll {
  private playhead: HTMLDivElement;
  private duration = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.playhead = document.createElement('div');
    Object.assign(this.playhead.style, {
      position: 'absolute', top: '0', bottom: '0', width: '2px', background: 'var(--cursor-edge)', pointerEvents: 'none', left: '0',
    });
    const wrap = canvas.parentElement!;
    wrap.style.position = 'relative';
    wrap.appendChild(this.playhead);
  }

  draw(analysis: AudioAnalysis, t: Transcription): void {
    const all = analysis.notes;
    const used = t.tracks.flatMap((tr) => tr.notes.map((n) => ({ ...n, instrument: tr.instrument })));
    const pitches = [...all.map((n) => n.pitch), ...used.map((n) => n.pitch)];
    const lo = Math.max(21, Math.min(...pitches, 40) - 2);
    const hi = Math.min(108, Math.max(...pitches, 52) + 2);
    this.duration = Math.max(1, analysis.duration);
    const width = Math.min(30000, Math.ceil(GUTTER + this.duration * PX_PER_SEC));
    const height = (hi - lo + 1) * ROW + 8;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.canvas;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const x = (sec: number) => GUTTER + sec * PX_PER_SEC;
    const y = (p: number) => 4 + (hi - p) * ROW;

    // Octave lines and labels.
    g.font = '10px system-ui, sans-serif';
    g.fillStyle = cssVar(c, '--muted');
    g.strokeStyle = cssVar(c, '--line');
    for (let p = lo; p <= hi; p++) {
      if (p % 12 !== 4 && p % 12 !== 0) continue; // E and C lines
      g.globalAlpha = p % 12 === 4 ? 0.9 : 0.4;
      g.beginPath();
      g.moveTo(GUTTER, y(p) + ROW / 2);
      g.lineTo(width, y(p) + ROW / 2);
      g.stroke();
      if (p % 12 === 4) g.fillText(noteName(p), 2, y(p) + ROW);
    }
    // Bar lines.
    const perBar = slotsPerBar(t.grid);
    g.globalAlpha = 0.6;
    for (let b = 0; ; b++) {
      const tb = slotToTime(t.grid, b * perBar);
      if (tb > this.duration) break;
      g.beginPath();
      g.moveTo(x(tb), 0);
      g.lineTo(x(tb), height);
      g.stroke();
    }
    g.globalAlpha = 1;

    const usedKeys = new Set(used.map((n) => `${n.detectedPitch}@${Math.round(n.start * 1000)}`));
    g.fillStyle = cssVar(c, '--ignored');
    for (const n of all) {
      if (usedKeys.has(`${n.pitch}@${Math.round(n.start * 1000)}`)) continue;
      g.fillRect(x(n.start), y(n.pitch), Math.max(2, (n.end - n.start) * PX_PER_SEC), ROW - 1);
    }
    const colors = { guitar: cssVar(c, '--guitar'), bass: cssVar(c, '--bass') };
    for (const n of used) {
      g.fillStyle = colors[n.instrument];
      g.globalAlpha = 0.45 + 0.55 * Math.min(1, n.amplitude);
      g.fillRect(x(n.start), y(n.detectedPitch), Math.max(2, (n.end - n.start) * PX_PER_SEC), ROW - 1);
    }
    g.globalAlpha = 1;
  }

  setTime(time: number, follow: boolean): void {
    const px = GUTTER + time * PX_PER_SEC;
    this.playhead.style.left = `${px}px`;
    const wrap = this.canvas.parentElement!;
    if (follow && wrap.offsetParent && (px < wrap.scrollLeft || px > wrap.scrollLeft + wrap.clientWidth - 20)) {
      wrap.scrollLeft = Math.max(0, px - wrap.clientWidth / 3);
    }
  }
}
