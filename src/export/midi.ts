/**
 * Standard MIDI File (type 1) export. Notes are placed on the quantised grid and a tempo map
 * follows the tracked beats, so the file lines up with bars in a DAW and still plays back in
 * time with the original recording.
 */
import type { Transcription } from '../music/interpret';

const PPQ = 480;

function varLen(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type: string, data: number[]): number[] {
  return [...[...type].map((c) => c.charCodeAt(0)), ...u32(data.length), ...data];
}

function text(metaType: number, s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [0xff, metaType, ...varLen(bytes.length), ...bytes];
}

interface TimedEvent {
  tick: number;
  order: number;
  bytes: number[];
}

function trackData(events: TimedEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  let last = 0;
  for (const e of events) {
    data.push(...varLen(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  data.push(0x00, 0xff, 0x2f, 0x00);
  return data;
}

export function toMidi(t: Transcription, title = 'Transcription'): Uint8Array {
  const { grid } = t;
  const ticksPerSlot = PPQ / grid.subdivision;

  // Tempo map: one tempo per beat from the first downbeat on.
  const conductor: TimedEvent[] = [
    { tick: 0, order: 0, bytes: text(0x03, title) },
    { tick: 0, order: 1, bytes: [0xff, 0x58, 0x04, grid.beatsPerBar, 2, 24, 8] },
  ];
  let lastTempo = -1;
  for (let b = grid.firstDownbeat; b + 1 < grid.beats.length; b++) {
    const us = Math.round((grid.beats[b + 1] - grid.beats[b]) * 1e6);
    if (us <= 0 || Math.abs(us - lastTempo) < 2000) continue;
    lastTempo = us;
    conductor.push({ tick: (b - grid.firstDownbeat) * PPQ, order: 2, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] });
  }

  const tracks = [trackData(conductor)];
  t.tracks.forEach((track, i) => {
    const channel = i;
    // GM programs (0-based): 27 = Electric Guitar (clean), 33 = Electric Bass (finger).
    const program = track.instrument === 'guitar' ? 27 : 33;
    const events: TimedEvent[] = [
      { tick: 0, order: 0, bytes: text(0x03, track.instrument === 'guitar' ? 'Guitar' : 'Bass') },
      { tick: 0, order: 1, bytes: [0xc0 | channel, program] },
    ];
    for (const n of track.notes) {
      const on = Math.max(0, n.slot) * ticksPerSlot;
      const off = Math.max(on + ticksPerSlot / 2, n.endSlot * ticksPerSlot);
      const velocity = Math.max(20, Math.min(127, Math.round(40 + n.amplitude * 87)));
      events.push({ tick: on, order: 3, bytes: [0x90 | channel, n.pitch, velocity] });
      events.push({ tick: off, order: 2, bytes: [0x80 | channel, n.pitch, 0] });
    }
    tracks.push(trackData(events));
  });

  const header = chunk('MThd', [0, 1, 0, tracks.length, (PPQ >> 8) & 0xff, PPQ & 0xff]);
  return new Uint8Array([...header, ...tracks.flatMap((d) => chunk('MTrk', d))]);
}
