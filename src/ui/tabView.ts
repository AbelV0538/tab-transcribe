/** Responsive tablature view with a playback cursor and tap-to-seek. */
import type { Track, Transcription } from '../music/interpret';
import { beatPosition, slotToTime, slotsPerBar } from '../music/rhythm';
import { columnOffsets, columnWidths, renderBar, renderChordLine } from '../music/tab';
import { stringLabels, type InstrumentKind } from '../music/tunings';

interface BarPlacement {
  system: HTMLElement;
  cursor: HTMLElement;
  /** Character column where the bar's content starts inside the system. */
  charStart: number;
  offsets: number[];
  widths: number[];
}

interface TrackLayout {
  track: Track;
  bars: BarPlacement[];
}

const NAMES: Record<InstrumentKind, string> = { guitar: 'Guitar', bass: 'Bass' };

export class TabView {
  private layouts: TrackLayout[] = [];
  private charWidth = 8;
  private transcription: Transcription | null = null;
  private visible: InstrumentKind[] = [];
  private lastBar = -1;
  private lastWidth = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly onSeek: (time: number) => void,
  ) {
    let timer = 0;
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (this.root.clientWidth !== this.lastWidth && this.transcription) this.render(this.transcription, this.visible);
      }, 120);
    }).observe(root);
  }

  private measureCharWidth(): number {
    const probe = document.createElement('div');
    probe.className = 'system';
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    const pre = document.createElement('pre');
    pre.textContent = '-'.repeat(100);
    probe.appendChild(pre);
    this.root.appendChild(probe);
    const w = pre.getBoundingClientRect().width / 100;
    probe.remove();
    return w || 8;
  }

  render(t: Transcription, visible: InstrumentKind[]): void {
    this.transcription = t;
    this.visible = visible;
    this.lastBar = -1;
    this.root.replaceChildren();
    this.layouts = [];
    this.lastWidth = this.root.clientWidth;
    const tracks = t.tracks.filter((tr) => visible.includes(tr.instrument));
    if (tracks.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = t.tracks.length ? 'Select a track above.' : 'No guitar or bass notes were detected in this recording.';
      this.root.appendChild(p);
      return;
    }
    this.charWidth = this.measureCharWidth();
    const style = getComputedStyle(this.root);
    const available = this.root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const maxChars = Math.max(20, Math.floor(available / this.charWidth));
    for (const track of tracks) this.layouts.push(this.renderTrack(track, t, maxChars));
  }

  private renderTrack(track: Track, t: Transcription, maxChars: number): TrackLayout {
    const section = document.createElement('section');
    section.className = 'track';
    const head = document.createElement('div');
    head.className = 'track-head';
    const h = document.createElement('h3');
    h.innerHTML = `<span class="dot ${track.instrument}"></span>`;
    h.append(NAMES[track.instrument]);
    const info = document.createElement('span');
    info.className = 'muted';
    info.textContent = `${track.tuning.name}${track.tuningWasAuto ? ' (auto)' : ''}${track.capo ? ` · capo ${track.capo}` : ''} · ${track.notes.length} notes`;
    head.append(h, info);
    section.appendChild(head);

    const labels = stringLabels(track.tuning);
    const n = labels.length;
    const labelWidth = Math.max(...labels.map((l) => l.length), String(track.bars.length).length);
    const prefix = labelWidth + 1;
    const rendered = track.bars.map((bar) => ({ bar, lines: renderBar(bar, n), chords: renderChordLine(bar) }));
    const placements: BarPlacement[] = [];

    let i = 0;
    while (i < rendered.length) {
      // Pack as many bars as fit on one line (at least one).
      const row = [rendered[i]];
      let width = prefix + rendered[i].lines[0].length + 1;
      while (i + row.length < rendered.length) {
        const next = rendered[i + row.length];
        if (width + next.lines[0].length + 1 > maxChars) break;
        row.push(next);
        width += next.lines[0].length + 1;
      }
      const system = document.createElement('div');
      system.className = 'system';
      const chordLine = document.createElement('div');
      chordLine.className = 'chordline';
      chordLine.textContent = String(i + 1).padEnd(prefix) + row.map((r) => r.chords).join(' ');
      const pre = document.createElement('pre');
      const lines: string[] = [];
      for (let s = 0; s < n; s++) lines.push(labels[n - 1 - s].padEnd(labelWidth) + '|' + row.map((r) => r.lines[s]).join('|') + '|');
      pre.textContent = lines.join('\n');
      const cursor = document.createElement('div');
      cursor.className = 'cursor';
      system.append(chordLine, pre, cursor);
      section.appendChild(system);

      let charStart = prefix;
      const rowPlacements: BarPlacement[] = [];
      for (const r of row) {
        const p = { system, cursor, charStart, offsets: columnOffsets(r.bar), widths: columnWidths(r.bar) };
        placements.push(p);
        rowPlacements.push(p);
        charStart += r.lines[0].length + 1;
      }
      const firstBar = i;
      pre.addEventListener('click', (ev) => {
        const x = ev.clientX - pre.getBoundingClientRect().left;
        const ch = Math.floor(x / this.charWidth);
        let k = rowPlacements.length - 1;
        while (k > 0 && rowPlacements[k].charStart > ch) k--;
        const p = rowPlacements[k];
        let col = 0;
        p.offsets.forEach((o, c) => {
          if (o <= ch - p.charStart + 1) col = c;
        });
        this.onSeek(Math.max(0, slotToTime(t.grid, (firstBar + k) * slotsPerBar(t.grid) + col)));
      });
      i += row.length;
    }
    this.root.appendChild(section);
    return { track, bars: placements };
  }

  /** Move the cursor to `time` (seconds); scroll it into view when `follow` is set. */
  setTime(time: number, follow: boolean): void {
    const t = this.transcription;
    if (!t || this.layouts.length === 0) return;
    const perBar = slotsPerBar(t.grid);
    const slot = Math.round((beatPosition(t.grid.beats, time) - t.grid.firstDownbeat) * t.grid.subdivision);
    const bar = Math.floor(slot / perBar);
    const col = slot - bar * perBar;
    for (const layout of this.layouts) {
      for (const p of layout.bars) p.cursor.style.display = 'none';
      const p = layout.bars[bar];
      if (!p || slot < 0) continue;
      p.cursor.style.display = 'block';
      p.cursor.style.left = `${(p.charStart + p.offsets[col] - 0.5) * this.charWidth}px`;
      p.cursor.style.width = `${(p.widths[col] + 1) * this.charWidth}px`;
    }
    if (follow && bar !== this.lastBar) {
      const p = this.layouts[0].bars[bar];
      if (p) {
        const r = p.system.getBoundingClientRect();
        if (r.top < 70 || r.bottom > window.innerHeight - 20) p.system.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    this.lastBar = bar;
  }
}
