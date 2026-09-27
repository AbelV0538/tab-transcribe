/** Draws a calibrated fret grid (and optionally the detected hand) onto a canvas. */
import { INLAY_FRETS, neckPoint, type NeckModel, type Point } from '../vision/neck';

export interface NeckDrawOptions {
  maxFret: number;
  /** Covered stretch of the neck to highlight (fractional frets). */
  hand?: [number, number] | null;
  /** Write fret numbers next to the marked frets. */
  labels?: boolean;
  /** Line colour for the frets. */
  color?: string;
}

export function drawNeckGrid(g: CanvasRenderingContext2D, model: NeckModel, toScreen: (p: Point) => Point, opts: NeckDrawOptions): void {
  const color = opts.color ?? 'rgba(80, 200, 255, 0.9)';
  const line = (a: Point, b: Point) => {
    const [x1, y1] = toScreen(a);
    const [x2, y2] = toScreen(b);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  };
  g.save();
  g.lineCap = 'round';
  if (opts.hand) {
    const [from, to] = opts.hand;
    const pts: Point[] = [];
    for (let f = from; f <= to + 1e-9; f += 0.1) pts.push(toScreen(neckPoint(model, f, -1.25)));
    for (let f = to; f >= from - 1e-9; f -= 0.1) pts.push(toScreen(neckPoint(model, f, 1.25)));
    g.fillStyle = 'rgba(245, 158, 11, 0.38)';
    g.strokeStyle = 'rgba(245, 158, 11, 0.95)';
    g.lineWidth = 2;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
    g.stroke();
  }
  // Board edges and centre line.
  g.strokeStyle = color;
  g.globalAlpha = 0.55;
  g.lineWidth = 1;
  for (const t of [-1, 1]) {
    g.beginPath();
    for (let f = 0; f <= opts.maxFret; f += 0.25) {
      const [x, y] = toScreen(neckPoint(model, f, t));
      if (f === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // Fret wires; the nut and 12th fret stronger.
  g.globalAlpha = 1;
  for (let k = 0; k <= opts.maxFret; k++) {
    g.lineWidth = k === 0 || k === 12 ? 2.5 : 1.3;
    line(neckPoint(model, k, -1), neckPoint(model, k, 1));
  }
  if (opts.labels) {
    g.font = '600 12px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const f of INLAY_FRETS.filter((n) => n <= opts.maxFret)) {
      const [x, y] = toScreen(neckPoint(model, f - 0.5, -1.9));
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.strokeText(String(f), x, y);
      g.fillStyle = '#fff';
      g.fillText(String(f), x, y);
    }
  }
  g.restore();
}
