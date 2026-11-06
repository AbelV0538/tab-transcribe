/**
 * Guitar Pro 7+ (`.gp`) reader for the benchmark: unpacks `Content/score.gpif` and flattens every
 * track into timed notes with their written string and fret.
 *
 * GPIF stores pools of objects referenced by id: MasterBar → Bar (one per track) → Voice →
 * Beat → Note / Rhythm. Beats and notes are shared between occurrences, so they are resolved
 * per occurrence. Repeats and jumps are not supported (the album's files use none).
 */
import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { readZipEntry } from './zip';

export interface GtNote {
  /** Sounding MIDI pitch (differs from the fretted pitch for harmonics). */
  pitch: number;
  /** Pitch of the fretted position: tuning[string] + capo + fret. */
  fretPitch: number;
  /** String index, 0 = lowest. */
  string: number;
  /** Fret relative to the capo, as written. */
  fret: number;
  /** Seconds from the start of the score (before alignment to a recording). */
  start: number;
  end: number;
  /** Index of the master bar the note starts in. */
  bar: number;
  tapped: boolean;
  leftHandTapped: boolean;
  /** Harmonic type ('Natural', 'Artificial', 'Pinch', …) or null. */
  harmonic: string | null;
  hopo: boolean;
  slide: boolean;
  grace: boolean;
  letRing: boolean;
  palmMuted: boolean;
}

export interface GpTrack {
  name: string;
  /** Open-string pitches, lowest string first. */
  tuning: number[];
  capo: number;
  frets: number;
  notes: GtNote[];
  /** Notes whose MIDI number disagrees with tuning + fret (should be 0). */
  pitchMismatches: number;
  /** Dead (muted) notes skipped. */
  deadNotes: number;
}

export interface TempoChange {
  /** Position in quarter notes from the start of the score. */
  quarter: number;
  /** Tempo in quarter notes per minute. */
  qpm: number;
}

export interface GpSong {
  title: string;
  tracks: GpTrack[];
  tempo: TempoChange[];
  /** Start of each master bar in seconds, plus the end of the last one. */
  barTimes: number[];
  /** Beats per bar of each master bar (numerator / denominator). */
  timeSignatures: Array<[number, number]>;
  duration: number;
}

const NOTE_VALUE_QUARTERS: Record<string, number> = {
  Whole: 4,
  Half: 2,
  Quarter: 1,
  Eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125,
};

/** Tempo reference units used in "bpm unit" values: 1 = eighth, 2 = quarter, … (in quarters). */
const TEMPO_UNIT_QUARTERS: Record<number, number> = { 1: 0.5, 2: 1, 3: 1.5, 4: 2, 5: 3 };

/** Element paths that may repeat (a name alone is ambiguous: a beat's `<Rhythm ref>` is not the pool's `<Rhythm>`). */
const ARRAY_PATHS = new Set([
  'GPIF.Tracks.Track',
  'GPIF.Tracks.Track.Staves.Staff',
  'GPIF.MasterBars.MasterBar',
  'GPIF.Bars.Bar',
  'GPIF.Voices.Voice',
  'GPIF.Beats.Beat',
  'GPIF.Notes.Note',
  'GPIF.Rhythms.Rhythm',
  'GPIF.MasterTrack.Automations.Automation',
]);

type Xml = Record<string, any>;

const ids = (s: unknown): number[] =>
  String(s ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);

function props(node: Xml | undefined): Map<string, Xml> {
  const out = new Map<string, Xml>();
  for (const p of node?.Properties?.Property ?? []) out.set(p['@_name'], p);
  return out;
}

/**
 * Semitones above the open string of the natural harmonic touched at fret `hf` (12 → octave,
 * 7 → octave + fifth, 5 → two octaves, …).
 */
export function harmonicInterval(hf: number): number {
  const d = 1 - 2 ** (-hf / 12); // fraction of the string from the nut to the touch point
  for (let n = 2; n <= 12; n++) {
    const k = Math.round(d * n);
    if (k >= 1 && Math.abs(d * n - k) < 0.04) return Math.round(12 * Math.log2(n));
  }
  return 12;
}

function byId(list: Xml[] | undefined): Map<number, Xml> {
  return new Map((list ?? []).map((x) => [Number(x['@_id']), x]));
}

function rhythmQuarters(r: Xml | undefined): number {
  if (!r) return 1;
  let q = NOTE_VALUE_QUARTERS[String(r.NoteValue)] ?? 1;
  const dots = Number(r.AugmentationDot?.['@_count'] ?? 0);
  if (dots === 1) q *= 1.5;
  else if (dots === 2) q *= 1.75;
  for (const t of [r.PrimaryTuplet, r.SecondaryTuplet]) {
    if (t) q *= Number(t['@_den']) / Number(t['@_num']);
  }
  return q;
}

export function parseGpif(xml: string): GpSong {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name, jpath) => name === 'Property' || ARRAY_PATHS.has(String(jpath)),
  });
  const root = parser.parse(xml).GPIF as Xml;
  const title = String(root.Score?.Title ?? '').trim();

  const masterBars: Xml[] = root.MasterBars?.MasterBar ?? [];
  const bars = byId(root.Bars?.Bar);
  const voices = byId(root.Voices?.Voice);
  const beats = byId(root.Beats?.Beat);
  const notes = byId(root.Notes?.Note);
  const rhythms = byId(root.Rhythms?.Rhythm);

  // Bar lengths and starts in quarter notes.
  const timeSignatures: Array<[number, number]> = masterBars.map((mb) => {
    const [num, den] = String(mb.Time ?? '4/4').split('/').map(Number);
    return [num, den];
  });
  const barStartQ: number[] = [0];
  timeSignatures.forEach(([num, den], i) => barStartQ.push(barStartQ[i] + (num * 4) / den));

  // Tempo map.
  const tempo: TempoChange[] = [];
  for (const a of root.MasterTrack?.Automations?.Automation ?? []) {
    if (String(a.Type) !== 'Tempo') continue;
    const bar = Number(a.Bar ?? 0);
    const pos = Number(a.Position ?? 0);
    const [bpm, unit] = String(a.Value).trim().split(/\s+/).map(Number);
    const barLen = barStartQ[bar + 1] - barStartQ[bar] || 4;
    tempo.push({ quarter: barStartQ[bar] + pos * barLen, qpm: bpm * (TEMPO_UNIT_QUARTERS[unit] ?? 1) });
  }
  tempo.sort((a, b) => a.quarter - b.quarter);
  if (tempo.length === 0 || tempo[0].quarter > 0) tempo.unshift({ quarter: 0, qpm: tempo[0]?.qpm ?? 120 });

  const qToSec = (q: number): number => {
    let t = 0;
    for (let i = 0; i < tempo.length; i++) {
      const from = tempo[i].quarter;
      const to = i + 1 < tempo.length ? tempo[i + 1].quarter : Infinity;
      if (q <= from) break;
      t += ((Math.min(q, to) - from) * 60) / tempo[i].qpm;
    }
    return t;
  };

  const trackNodes: Xml[] = root.Tracks?.Track ?? [];
  const tracks: GpTrack[] = trackNodes.map((tn, trackIndex) => {
    const staff = tn.Staves?.Staff?.[0];
    const sp = props(staff);
    const tuning = ids(sp.get('Tuning')?.Pitches);
    const capo = Number(sp.get('CapoFret')?.Fret ?? 0);
    const frets = Number(sp.get('FretCount')?.Number ?? 24);
    const track: GpTrack = { name: String(tn.Name ?? '').trim(), tuning, capo, frets, notes: [], pitchMismatches: 0, deadNotes: 0 };
    const lastOnString = new Map<number, GtNote>();
    const emitBeat = (b: Xml, startQ: number, durQ: number, grace: boolean, barIndex: number) => {
      for (const noteId of ids(b.Notes)) {
        const n = notes.get(noteId);
        if (!n) continue;
        const np = props(n);
        const start = qToSec(startQ);
        const end = qToSec(startQ + durQ);
        const string = Number(np.get('String')?.String);
        const fret = Number(np.get('Fret')?.Fret);
        if (np.has('Muted')) {
          track.deadNotes++;
          continue;
        }
        if (n.Tie?.['@_destination'] === 'true') {
          const prev = lastOnString.get(string);
          if (prev) {
            prev.end = Math.max(prev.end, end);
            continue;
          }
        }
        const fretPitch = tuning[string] + capo + fret;
        const midi = Number(np.get('Midi')?.Number ?? fretPitch);
        if (midi !== fretPitch) track.pitchMismatches++;
        const harmonic = np.has('HarmonicType') ? String(np.get('HarmonicType')!.HType) : null;
        let pitch = fretPitch;
        if (harmonic) {
          const hf = Number(np.get('HarmonicFret')?.HFret ?? 12);
          pitch = harmonic === 'Natural' ? tuning[string] + capo + harmonicInterval(hf) : fretPitch + harmonicInterval(hf);
        }
        const note: GtNote = {
          pitch,
          fretPitch,
          string,
          fret,
          start,
          end,
          bar: barIndex,
          tapped: np.has('Tapped'),
          leftHandTapped: np.has('LeftHandTapped'),
          harmonic,
          hopo: np.has('HopoOrigin') || np.has('HopoDestination'),
          slide: np.has('Slide'),
          grace,
          letRing: 'LetRing' in n,
          palmMuted: np.has('PalmMuted'),
        };
        track.notes.push(note);
        lastOnString.set(string, note);
      }
    };

    masterBars.forEach((mb, barIndex) => {
      const barId = ids(mb.Bars)[trackIndex];
      const bar = bars.get(barId);
      if (!bar) return;
      for (const voiceId of ids(bar.Voices)) {
        if (voiceId < 0) continue;
        const voice = voices.get(voiceId);
        if (!voice) continue;
        let q = barStartQ[barIndex];
        let pendingGrace: Array<{ beat: Xml; dur: number }> = [];
        for (const beatId of ids(voice.Beats)) {
          const beat = beats.get(beatId);
          if (!beat) continue;
          const dur = rhythmQuarters(rhythms.get(Number(beat.Rhythm?.['@_ref'])));
          if (beat.GraceNotes) {
            pendingGrace.push({ beat, dur: Math.min(dur, 0.125) });
            continue;
          }
          // Grace notes before this beat: before the beat they steal time from the previous
          // beat; on the beat they delay this one.
          let onsetQ = q;
          if (pendingGrace.length) {
            const total = pendingGrace.reduce((s, g) => s + g.dur, 0);
            const onBeat = pendingGrace.some((g) => String(g.beat.GraceNotes) === 'OnBeat');
            let gq = onBeat ? q : q - total;
            for (const g of pendingGrace) {
              emitBeat(g.beat, gq, g.dur, true, barIndex);
              gq += g.dur;
            }
            if (onBeat) onsetQ = q + total;
            pendingGrace = [];
          }
          emitBeat(beat, onsetQ, q + dur - onsetQ, false, barIndex);
          q += dur;
        }
      }
    });
    track.notes.sort((a, b) => a.start - b.start || a.string - b.string);
    return track;
  });

  const barTimes = barStartQ.map(qToSec);
  return { title, tracks, tempo, barTimes, timeSignatures, duration: barTimes[barTimes.length - 1] };
}

export function readGpFile(file: string): GpSong {
  const xml = readZipEntry(fs.readFileSync(file), 'Content/score.gpif');
  if (!xml) throw new Error(`${file}: no Content/score.gpif (only Guitar Pro 7+ files are supported)`);
  return parseGpif(xml.toString('utf8'));
}
