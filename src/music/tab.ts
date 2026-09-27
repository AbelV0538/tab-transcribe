/** Lay fingered, quantised notes out as tablature bars and render them as text. */
import { chordName } from './theory';
import { stringLabels, type Tuning } from './tunings';

export interface TabNote {
  pitch: number;
  string: number;
  fret: number;
  slot: number;
  endSlot: number;
  amplitude: number;
}

export interface TabCell {
  string: number;
  fret: number;
  /** Index of the note in the track's note list. */
  note: number;
}

export interface TabBar {
  index: number;
  startSlot: number;
  /** One entry per grid slot in the bar; each is the list of notes starting there. */
  columns: TabCell[][];
  /** Chord symbol above a column (only where it changes), keyed by column. */
  chords: Map<number, string>;
}

export function layoutBars(notes: TabNote[], slotsPerBar: number, minBars = 1): TabBar[] {
  const lastSlot = notes.reduce((m, n) => Math.max(m, n.slot), 0);
  const nBars = Math.max(minBars, Math.floor(lastSlot / slotsPerBar) + 1);
  const bars: TabBar[] = [];
  for (let b = 0; b < nBars; b++) {
    bars.push({ index: b, startSlot: b * slotsPerBar, columns: Array.from({ length: slotsPerBar }, () => []), chords: new Map() });
  }
  const occupied = new Map<string, number>(); // "slot:string" → note index
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].slot - notes[b].slot || notes[a].string - notes[b].string);
  for (const i of order) {
    const n = notes[i];
    let slot = Math.max(0, n.slot);
    const key = (s: number) => `${s}:${n.string}`;
    if (occupied.has(key(slot))) {
      // Two notes on one string in the same slot: nudge the later one if there is room.
      if (!occupied.has(key(slot + 1)) && slot + 1 < Math.max(n.endSlot, slot + 2)) slot += 1;
      else {
        const other = occupied.get(key(slot))!;
        if (notes[other].amplitude >= n.amplitude) continue;
        const bar = bars[Math.floor(slot / slotsPerBar)];
        const col = bar.columns[slot % slotsPerBar];
        col.splice(col.findIndex((c) => c.note === other), 1);
      }
    }
    const barIdx = Math.floor(slot / slotsPerBar);
    while (barIdx >= bars.length) {
      const b = bars.length;
      bars.push({ index: b, startSlot: b * slotsPerBar, columns: Array.from({ length: slotsPerBar }, () => []), chords: new Map() });
    }
    bars[barIdx].columns[slot % slotsPerBar].push({ string: n.string, fret: n.fret, note: i });
    occupied.set(key(slot), i);
  }
  // Chord symbols for columns with three or more notes, shown when they change.
  let lastChord: string | null = null;
  for (const bar of bars) {
    bar.columns.forEach((col, c) => {
      if (col.length < 3) return;
      const name = chordName(col.map((cell) => notes[cell.note].pitch));
      if (name && name !== lastChord) bar.chords.set(c, name);
      if (name) lastChord = name;
    });
  }
  return bars;
}

/** Character width of each column (widest fret number, at least 1). */
export function columnWidths(bar: TabBar): number[] {
  return bar.columns.map((col) => Math.max(1, ...col.map((c) => String(c.fret).length)));
}

/** Character offset of each column's first character within a rendered bar line. */
export function columnOffsets(bar: TabBar): number[] {
  const widths = columnWidths(bar);
  const offsets: number[] = [];
  let x = 0;
  widths.forEach((w) => {
    offsets.push(x + 1);
    x += w + 1;
  });
  return offsets;
}

/** Text of one bar, one line per string, highest string first. No bar lines or labels. */
export function renderBar(bar: TabBar, nStrings: number): string[] {
  const widths = columnWidths(bar);
  const lines: string[] = [];
  for (let s = nStrings - 1; s >= 0; s--) {
    let line = '';
    bar.columns.forEach((col, c) => {
      const cell = col.find((x) => x.string === s);
      line += '-' + (cell ? String(cell.fret) : '').padEnd(widths[c], '-');
    });
    lines.push(line + '-');
  }
  return lines;
}

/** Chord-symbol line aligned with a rendered bar (same width). */
export function renderChordLine(bar: TabBar): string {
  const offsets = columnOffsets(bar);
  const width = renderBar(bar, 1)[0].length;
  const chars = new Array<string>(width).fill(' ');
  let blockedUntil = 0;
  for (const [c, name] of [...bar.chords.entries()].sort((a, b) => a[0] - b[0])) {
    const at = Math.max(offsets[c], blockedUntil);
    for (let k = 0; k < name.length && at + k < width; k++) chars[at + k] = name[k];
    blockedUntil = at + name.length + 1;
  }
  return chars.join('');
}

export interface AsciiOptions {
  barsPerLine: number;
  header?: string[];
}

/** Classic plain-text tablature. */
export function renderAsciiTab(bars: TabBar[], tuning: Tuning, opts: AsciiOptions): string {
  const labels = stringLabels(tuning);
  // Wide enough for string names and for the bar number printed above each system.
  const labelWidth = Math.max(...labels.map((l) => l.length), String(bars.length).length);
  const nStrings = tuning.strings.length;
  const out: string[] = [...(opts.header ?? [])];
  if (out.length) out.push('');
  for (let i = 0; i < bars.length; i += opts.barsPerLine) {
    const row = bars.slice(i, i + opts.barsPerLine);
    const rendered = row.map((b) => renderBar(b, nStrings));
    const chordLine = row.map((b) => renderChordLine(b)).join(' ');
    out.push((String(i + 1).padEnd(labelWidth + 1) + chordLine).trimEnd());
    for (let s = 0; s < nStrings; s++) {
      const label = labels[nStrings - 1 - s].padEnd(labelWidth);
      out.push(label + '|' + rendered.map((r) => r[s]).join('|') + '|');
    }
    out.push('');
  }
  return out.join('\n');
}
