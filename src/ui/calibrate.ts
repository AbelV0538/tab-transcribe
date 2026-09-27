/**
 * Calibration for playthrough videos: the user picks a frame and marks two (optionally three)
 * fret spaces they can identify. The fitted fret grid is drawn live so they can see it line up.
 */
import type { InstrumentKind } from '../music/tunings';
import { calibrateNeck, type FretMark } from '../vision/neck';
import type { Calibration } from '../vision/pipeline';
import { VideoFrames } from '../vision/video';
import { drawNeckGrid } from './neckDraw';

const DEFAULT_FRETS = [5, 12, 9];
const MARK_COLORS = ['#f59e0b', '#22c55e', '#e879f9'];

export class CalibrationView {
  private frames: VideoFrames | null = null;
  /** The file currently shown (null while nothing is loaded). */
  loadedFile: File | null = null;
  private image: HTMLCanvasElement | null = null;
  private marks: Array<{ x: number; y: number } | null> = [null, null, null];
  private frets = [...DEFAULT_FRETS];
  private active = 0;
  private time = 0;
  private instrument: InstrumentKind = 'bass';
  private loadToken = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly slider: HTMLInputElement;
  private readonly marksBox: HTMLElement;
  private readonly status: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (calibration: Calibration | null) => void,
  ) {
    this.canvas = root.querySelector('canvas')!;
    this.slider = root.querySelector('input[type=range]')!;
    this.marksBox = root.querySelector('.calib-marks')!;
    this.status = root.querySelector('.calib-status')!;
    this.renderControls();
    this.slider.addEventListener('input', () => void this.showFrame((Number(this.slider.value) / 1000) * (this.frames?.duration ?? 0)));
    let dragging = false;
    const place = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      if (x < 0 || y < 0 || x > 1 || y > 1) return;
      this.marks[this.active] = { x, y };
      this.draw();
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.image) return;
      e.preventDefault();
      dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      place(e);
    });
    this.canvas.addEventListener('pointermove', (e) => dragging && place(e));
    const end = () => {
      if (!dragging) return;
      dragging = false;
      // Move on to the next mark that hasn't been placed.
      const next = this.marks.findIndex((m, i) => !m && i < 2);
      if (next >= 0) this.setActive(next);
      this.changed();
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    new ResizeObserver(() => this.layout()).observe(root);
  }

  setInstrument(instrument: InstrumentKind): void {
    this.instrument = instrument;
    this.draw();
    this.changed();
  }

  async load(file: File): Promise<void> {
    const token = ++this.loadToken;
    this.frames?.close();
    this.frames = null;
    this.image = null;
    this.marks = [null, null, null];
    this.frets = [...DEFAULT_FRETS];
    this.renderControls();
    this.setActive(0);
    this.status.textContent = 'Loading video…';
    this.loadedFile = file;
    const frames = await VideoFrames.open(file, 720);
    if (token !== this.loadToken) {
      frames.close();
      return;
    }
    this.frames = frames;
    this.slider.value = '333';
    await this.showFrame(frames.duration / 3);
    this.changed();
  }

  close(): void {
    this.loadToken++;
    this.frames?.close();
    this.frames = null;
    this.image = null;
    this.loadedFile = null;
    this.marks = [null, null, null];
  }

  get calibration(): Calibration | null {
    const marks: FretMark[] = [];
    this.marks.forEach((m, i) => m && marks.push({ x: m.x, y: m.y, fret: this.frets[i] }));
    if (marks.length < 2 || new Set(marks.map((m) => m.fret)).size !== marks.length) return null;
    return { time: this.time, marks };
  }

  private changed() {
    const c = this.calibration;
    const placed = this.marks.filter(Boolean).length;
    if (!this.image) this.status.textContent = 'Loading video…';
    else if (placed < 2) this.status.textContent = `Tap the ${placed === 0 ? 'first' : 'second'} fret space on the neck (mark ${this.active + 1}).`;
    else if (!c) this.status.textContent = 'Give each mark a different fret number.';
    else this.status.textContent = 'Check that the blue lines sit on the fret wires. Drag a mark to adjust it.';
    this.onChange(c);
  }

  private setActive(i: number) {
    this.active = i;
    this.marksBox.querySelectorAll<HTMLButtonElement>('button[data-mark]').forEach((b) => b.classList.toggle('on', Number(b.dataset.mark) === i));
  }

  private renderControls() {
    this.marksBox.replaceChildren();
    this.frets.forEach((fret, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'calib-mark';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.mark = String(i);
      btn.innerHTML = `<span class="dot" style="background:${MARK_COLORS[i]}"></span>Mark ${i + 1}${i === 2 ? ' <span class="muted">(optional)</span>' : ''}`;
      btn.addEventListener('click', () => this.setActive(i));
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Fret of mark ${i + 1}`);
      for (let f = 1; f <= 24; f++) select.add(new Option(`fret ${f}`, String(f)));
      select.value = String(fret);
      select.addEventListener('change', () => {
        this.frets[i] = Number(select.value);
        this.draw();
        this.changed();
      });
      wrap.append(btn, select);
      if (i === 2) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'link';
        clear.textContent = 'clear';
        clear.addEventListener('click', () => {
          this.marks[2] = null;
          this.draw();
          this.changed();
        });
        wrap.append(clear);
      }
      this.marksBox.append(wrap);
    });
    this.setActive(this.active);
  }

  private async showFrame(time: number) {
    const frames = this.frames;
    if (!frames) return;
    this.time = time;
    const img = document.createElement('canvas');
    img.width = frames.width;
    img.height = frames.height;
    await frames.drawAt(time, img.getContext('2d')!, img.width, img.height);
    if (frames !== this.frames) return;
    this.image = img;
    this.layout();
    this.changed();
  }

  private layout() {
    if (!this.image) return;
    const maxW = Math.min(this.root.clientWidth || 360, 560);
    const maxH = Math.max(240, window.innerHeight * 0.62);
    const aspect = this.image.width / this.image.height;
    const w = Math.min(maxW, maxH * aspect);
    this.canvas.style.width = `${Math.round(w)}px`;
    this.canvas.style.height = `${Math.round(w / aspect)}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round((w / aspect) * dpr);
    this.draw();
  }

  private draw() {
    const g = this.canvas.getContext('2d');
    if (!g || !this.image) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.drawImage(this.image, 0, 0, W, H);
    const c = this.calibration;
    if (c) {
      try {
        const model = calibrateNeck(c.marks.map((m) => ({ ...m, x: m.x * W, y: m.y * H })), this.instrument);
        drawNeckGrid(g, model, (p) => p, { maxFret: this.instrument === 'bass' ? 21 : 22, labels: true });
      } catch {
        /* marks too close together: nothing to draw yet */
      }
    }
    const r = Math.max(6, W / 70);
    this.marks.forEach((m, i) => {
      if (!m) return;
      g.beginPath();
      g.arc(m.x * W, m.y * H, r, 0, Math.PI * 2);
      g.fillStyle = MARK_COLORS[i];
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#000';
      g.stroke();
      g.fillStyle = '#000';
      g.font = `700 ${Math.round(r * 1.3)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(this.frets[i]), m.x * W, m.y * H + 0.5);
    });
  }
}
