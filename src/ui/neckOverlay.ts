/** Draws the tracked fret grid and the detected fretting hand over the playing video. */
import { frameIndexAt, type VideoAnalysis } from '../vision/pipeline';
import { applyAffine } from '../vision/track';
import { drawNeckGrid } from './neckDraw';

export class NeckOverlay {
  private readonly canvas: HTMLCanvasElement;
  private analysis: VideoAnalysis | null = null;
  private video: HTMLVideoElement | null = null;
  enabled = true;

  constructor(private readonly box: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'neck-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
  }

  /** Call after the player created its video element (or with null for audio files). */
  attach(video: HTMLVideoElement | null): void {
    this.video = video;
    if (video) this.box.appendChild(this.canvas);
    else this.canvas.remove();
  }

  setAnalysis(analysis: VideoAnalysis | null): void {
    this.analysis = analysis;
    this.clear();
  }

  private clear() {
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(time: number): void {
    const { video, analysis } = this;
    if (!video || !analysis || !this.enabled || !video.videoWidth) {
      this.clear();
      return;
    }
    // The picture inside the element (object-fit: contain).
    const cw = video.clientWidth;
    const ch = video.clientHeight;
    const scale = Math.min(cw / video.videoWidth, ch / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    Object.assign(this.canvas.style, { left: `${video.offsetLeft}px`, top: `${video.offsetTop}px`, width: `${cw}px`, height: `${ch}px` });
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const i = frameIndexAt(analysis, time);
    if (Math.abs(analysis.times[i] - time) > 0.3) return;
    const warp = analysis.warps[i];
    if (!warp) return;
    const k = (w / analysis.width) * dpr;
    const ox = ((cw - w) / 2) * dpr;
    const oy = ((ch - h) / 2) * dpr;
    const obs = analysis.observations[i];
    g.save();
    g.beginPath();
    g.rect(ox, oy, w * dpr, h * dpr);
    g.clip();
    drawNeckGrid(
      g,
      analysis.model,
      (p) => {
        const [x, y] = applyAffine(warp, p[0], p[1]);
        return [ox + x * k, oy + y * k];
      },
      {
        maxFret: analysis.instrument === 'bass' ? 21 : 22,
        hand: obs && obs.from !== null && obs.to !== null ? [obs.from, obs.to] : null,
        color: 'rgba(80, 200, 255, 0.7)',
      },
    );
    g.restore();
  }
}
