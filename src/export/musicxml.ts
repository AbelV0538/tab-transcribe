/**
 * MusicXML 4.0 export with tablature staves (string/fret for every note). Opens in MuseScore,
 * Guitar Pro, TuxGuitar, Sibelius, Finale and most notation apps.
 */
import type { Track, Transcription } from '../music/interpret';
import { pitchSpelling } from '../music/theory';

interface NoteValue {
  slots: number;
  type: string;
  dots: number;
  triplet: boolean;
}

function noteValues(subdivision: number): NoteValue[] {
  if (subdivision === 3) {
    return [
      { slots: 12, type: 'whole', dots: 0, triplet: false },
      { slots: 9, type: 'half', dots: 1, triplet: false },
      { slots: 6, type: 'half', dots: 0, triplet: false },
      { slots: 3, type: 'quarter', dots: 0, triplet: false },
      { slots: 2, type: 'quarter', dots: 0, triplet: true },
      { slots: 1, type: 'eighth', dots: 0, triplet: true },
    ];
  }
  return [
    { slots: 16, type: 'whole', dots: 0, triplet: false },
    { slots: 12, type: 'half', dots: 1, triplet: false },
    { slots: 8, type: 'half', dots: 0, triplet: false },
    { slots: 6, type: 'quarter', dots: 1, triplet: false },
    { slots: 4, type: 'quarter', dots: 0, triplet: false },
    { slots: 3, type: 'eighth', dots: 1, triplet: false },
    { slots: 2, type: 'eighth', dots: 0, triplet: false },
    { slots: 1, type: '16th', dots: 0, triplet: false },
  ];
}

/** Split a duration (in slots) into notatable values, largest first. */
export function splitDuration(slots: number, subdivision: number): NoteValue[] {
  const values = noteValues(subdivision);
  const out: NoteValue[] = [];
  let rest = slots;
  while (rest > 0) {
    const v = values.find((x) => x.slots <= rest) ?? values[values.length - 1];
    out.push(v);
    rest -= v.slots;
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function valueXml(v: NoteValue): string {
  return (
    `<type>${v.type}</type>` +
    '<dot/>'.repeat(v.dots) +
    (v.triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '')
  );
}

interface ChordEvent {
  slot: number;
  duration: number;
  notes: Track['notes'];
}

function partXml(track: Track, t: Transcription, partId: string): string {
  const { grid } = t;
  const perBar = grid.beatsPerBar * grid.subdivision;
  const nStrings = track.tuning.strings.length;

  // Chord events on the grid; each lasts until its longest note ends or the next event starts.
  const bySlot = new Map<number, Track['notes']>();
  for (const n of track.notes) {
    const slot = Math.max(0, n.slot);
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    const list = bySlot.get(slot)!;
    if (!list.some((m) => m.string === n.string)) list.push(n);
  }
  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  const events: ChordEvent[] = slots.map((slot, i) => {
    const notes = bySlot.get(slot)!.sort((a, b) => b.string - a.string);
    const longest = Math.max(...notes.map((n) => n.endSlot));
    const next = i + 1 < slots.length ? slots[i + 1] : Infinity;
    return { slot, duration: Math.max(1, Math.min(longest, next) - slot), notes };
  });

  const measures: string[] = [];
  let e = 0;
  for (let bar = 0; bar < track.bars.length; bar++) {
    const barStart = bar * perBar;
    const barEnd = barStart + perBar;
    let xml = `<measure number="${bar + 1}">`;
    if (bar === 0) {
      const tuningLines = track.tuning.strings
        .map((p, i) => {
          const sp = pitchSpelling(p);
          return `<staff-tuning line="${i + 1}"><tuning-step>${sp.step}</tuning-step>${sp.alter ? `<tuning-alter>${sp.alter}</tuning-alter>` : ''}<tuning-octave>${sp.octave}</tuning-octave></staff-tuning>`;
        })
        .join('');
      xml +=
        `<attributes><divisions>${grid.subdivision}</divisions><key><fifths>0</fifths></key>` +
        `<time><beats>${grid.beatsPerBar}</beats><beat-type>4</beat-type></time>` +
        `<clef><sign>TAB</sign><line>5</line></clef>` +
        `<staff-details><staff-lines>${nStrings}</staff-lines>${tuningLines}${track.capo ? `<capo>${track.capo}</capo>` : ''}</staff-details></attributes>` +
        `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${grid.bpm}</per-minute></metronome></direction-type><sound tempo="${grid.bpm}"/></direction>`;
    }
    let cursor = barStart;
    const rest = (len: number) => {
      for (const v of splitDuration(len, grid.subdivision)) {
        xml += `<note><rest/><duration>${v.slots}</duration><voice>1</voice>${valueXml(v)}</note>`;
      }
    };
    while (e < events.length && events[e].slot < barEnd) {
      const ev = events[e++];
      if (ev.slot > cursor) rest(ev.slot - cursor);
      const len = Math.min(ev.duration, barEnd - ev.slot);
      const parts = splitDuration(len, grid.subdivision);
      parts.forEach((v, k) => {
        const tieStart = k < parts.length - 1;
        const tieStop = k > 0;
        ev.notes.forEach((n, j) => {
          const sp = pitchSpelling(n.pitch);
          xml +=
            '<note>' +
            (j > 0 ? '<chord/>' : '') +
            `<pitch><step>${sp.step}</step>${sp.alter ? `<alter>${sp.alter}</alter>` : ''}<octave>${sp.octave}</octave></pitch>` +
            `<duration>${v.slots}</duration>` +
            (tieStop ? '<tie type="stop"/>' : '') +
            (tieStart ? '<tie type="start"/>' : '') +
            `<voice>1</voice>${valueXml(v)}` +
            '<notations>' +
            (tieStop ? '<tied type="stop"/>' : '') +
            (tieStart ? '<tied type="start"/>' : '') +
            `<technical><string>${nStrings - n.string}</string><fret>${n.fret}</fret></technical></notations>` +
            '</note>';
        });
      });
      cursor = ev.slot + len;
    }
    if (cursor < barEnd) rest(barEnd - cursor);
    measures.push(xml + '</measure>');
  }
  return `<part id="${partId}">${measures.join('')}</part>`;
}

export function toMusicXml(t: Transcription, title = 'Transcription'): string {
  const parts = t.tracks.map((track, i) => ({ id: `P${i + 1}`, track }));
  const partList = parts
    .map(
      ({ id, track }, i) =>
        `<score-part id="${id}"><part-name>${track.instrument === 'guitar' ? 'Guitar' : 'Bass'}</part-name>` +
        `<score-instrument id="${id}-I1"><instrument-name>${track.instrument === 'guitar' ? 'Electric Guitar' : 'Electric Bass'}</instrument-name></score-instrument>` +
        `<midi-instrument id="${id}-I1"><midi-channel>${i + 1}</midi-channel><midi-program>${track.instrument === 'guitar' ? 28 : 34}</midi-program></midi-instrument></score-part>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n' +
    '<score-partwise version="4.0">' +
    `<work><work-title>${esc(title)}</work-title></work>` +
    '<identification><encoding><software>Tab Transcribe</software></encoding></identification>' +
    `<part-list>${partList}</part-list>` +
    parts.map(({ id, track }) => partXml(track, t, id)).join('') +
    '</score-partwise>\n'
  );
}
