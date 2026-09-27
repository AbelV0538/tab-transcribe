/** Plain-text tablature document with a header for every track. */
import type { Track, Transcription } from '../music/interpret';
import { renderAsciiTab } from '../music/tab';

export function trackHeader(track: Track, t: Transcription): string[] {
  const name = track.instrument === 'guitar' ? 'Guitar' : 'Bass';
  const lines = [`${name} — tuning: ${track.tuning.name}${track.capo ? `, capo ${track.capo}` : ''}`];
  lines.push(`Tempo: ${t.grid.bpm} BPM, ${t.grid.beatsPerBar}/4, grid: ${t.grid.subdivision === 3 ? 'eighth-note triplets' : 'sixteenth notes'}`);
  if (track.notes.some((n) => n.folded)) lines.push('Some notes were moved by an octave to fit the instrument.');
  return lines;
}

export function toTabText(t: Transcription, title: string, barsPerLine = 4): string {
  const out: string[] = [title, '='.repeat(Math.min(60, title.length)), ''];
  for (const track of t.tracks) {
    out.push(renderAsciiTab(track.bars, track.tuning, { barsPerLine, header: trackHeader(track, t) }));
    out.push('');
  }
  out.push('Transcribed with Tab Transcribe.');
  return out.join('\n');
}
