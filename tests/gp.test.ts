import { describe, expect, it } from 'vitest';
import { harmonicInterval, parseGpif } from './album/gp';

/**
 * A tiny GPIF score: one 6-string track in standard tuning, two 4/4 bars at 120 bpm, then a
 * tempo change to 60 bpm in bar 2. Bar 1: dotted quarter E2 (open), eighth tied to it, a
 * triplet-eighth run (B2 at A fret 2 hammered, harmonic at fret 12 on G twice), a quarter rest. Bar 2: two
 * voices, a quarter note each beat 1, plus a dead note and a grace note before beat 2.
 */
const GPIF = `<?xml version="1.0" encoding="utf-8"?>
<GPIF>
<Score><Title><![CDATA[Test Song]]></Title></Score>
<MasterTrack>
<Tracks>0</Tracks>
<Automations>
<Automation><Type>Tempo</Type><Linear>false</Linear><Bar>0</Bar><Position>0</Position><Visible>true</Visible><Value>120 2</Value></Automation>
<Automation><Type>Tempo</Type><Linear>false</Linear><Bar>1</Bar><Position>0</Position><Visible>true</Visible><Value>60 2</Value></Automation>
</Automations>
</MasterTrack>
<Tracks>
<Track id="0">
<Name><![CDATA[Guitar]]></Name>
<Staves><Staff><Properties>
<Property name="CapoFret"><Fret>0</Fret></Property>
<Property name="FretCount"><Number>24</Number></Property>
<Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property>
</Properties></Staff></Staves>
</Track>
</Tracks>
<MasterBars>
<MasterBar><Time>4/4</Time><Bars>0</Bars></MasterBar>
<MasterBar><Time>4/4</Time><Bars>1</Bars></MasterBar>
</MasterBars>
<Bars>
<Bar id="0"><Voices>0 -1 -1 -1</Voices></Bar>
<Bar id="1"><Voices>1 2 -1 -1</Voices></Bar>
</Bars>
<Voices>
<Voice id="0"><Beats>0 1 2 3 3 4</Beats></Voice>
<Voice id="1"><Beats>5 6 7</Beats></Voice>
<Voice id="2"><Beats>8</Beats></Voice>
</Voices>
<Beats>
<Beat id="0"><Rhythm ref="0" /><Notes>0</Notes></Beat>
<Beat id="1"><Rhythm ref="1" /><Notes>1</Notes></Beat>
<Beat id="2"><Rhythm ref="2" /><Notes>2</Notes></Beat>
<Beat id="3"><Rhythm ref="2" /><Notes>3</Notes></Beat>
<Beat id="4"><Rhythm ref="4" /></Beat>
<Beat id="5"><Rhythm ref="4" /><Notes>4 5</Notes></Beat>
<Beat id="6"><GraceNotes>BeforeBeat</GraceNotes><Rhythm ref="5" /><Notes>6</Notes></Beat>
<Beat id="7"><Rhythm ref="4" /><Notes>7</Notes></Beat>
<Beat id="8"><Rhythm ref="4" /><Notes>8</Notes></Beat>
</Beats>
<Notes>
<Note id="0"><Tie origin="true" destination="false" /><Properties><Property name="Fret"><Fret>0</Fret></Property><Property name="Midi"><Number>40</Number></Property><Property name="String"><String>0</String></Property></Properties></Note>
<Note id="1"><Tie origin="false" destination="true" /><Properties><Property name="Fret"><Fret>0</Fret></Property><Property name="Midi"><Number>40</Number></Property><Property name="String"><String>0</String></Property></Properties></Note>
<Note id="2"><Properties><Property name="Fret"><Fret>2</Fret></Property><Property name="HopoOrigin"><Enable /></Property><Property name="Midi"><Number>47</Number></Property><Property name="String"><String>1</String></Property></Properties></Note>
<Note id="3"><Properties><Property name="Fret"><Fret>12</Fret></Property><Property name="Harmonic"><Enable /></Property><Property name="HarmonicFret"><HFret>12.000000</HFret></Property><Property name="HarmonicType"><HType>Natural</HType></Property><Property name="Midi"><Number>67</Number></Property><Property name="String"><String>3</String></Property></Properties></Note>
<Note id="4"><Properties><Property name="Fret"><Fret>3</Fret></Property><Property name="Midi"><Number>43</Number></Property><Property name="String"><String>0</String></Property></Properties></Note>
<Note id="5"><Properties><Property name="Fret"><Fret>0</Fret></Property><Property name="Muted"><Enable /></Property><Property name="Midi"><Number>50</Number></Property><Property name="String"><String>2</String></Property></Properties></Note>
<Note id="6"><Properties><Property name="Fret"><Fret>5</Fret></Property><Property name="Midi"><Number>64</Number></Property><Property name="String"><String>4</String></Property></Properties></Note>
<Note id="7"><Properties><Property name="Fret"><Fret>7</Fret></Property><Property name="Midi"><Number>66</Number></Property><Property name="String"><String>4</String></Property></Properties></Note>
<Note id="8"><LetRing /><Properties><Property name="Fret"><Fret>2</Fret></Property><Property name="Midi"><Number>66</Number></Property><Property name="String"><String>5</String></Property></Properties></Note>
</Notes>
<Rhythms>
<Rhythm id="0"><NoteValue>Quarter</NoteValue><AugmentationDot count="1" /></Rhythm>
<Rhythm id="1"><NoteValue>Eighth</NoteValue></Rhythm>
<Rhythm id="2"><NoteValue>Eighth</NoteValue><PrimaryTuplet num="3" den="2" /></Rhythm>
<Rhythm id="4"><NoteValue>Quarter</NoteValue></Rhythm>
<Rhythm id="5"><NoteValue>32nd</NoteValue></Rhythm>
</Rhythms>
</GPIF>`;

describe('Guitar Pro (GPIF) reader', () => {
  const song = parseGpif(GPIF);
  const notes = song.tracks[0].notes;
  const at = (s: number) => notes.find((n) => Math.abs(n.start - s) < 1e-6);

  it('reads the track, tuning and tempo map', () => {
    expect(song.title).toBe('Test Song');
    expect(song.tracks[0]).toMatchObject({ name: 'Guitar', tuning: [40, 45, 50, 55, 59, 64], capo: 0, frets: 24, pitchMismatches: 0 });
    // Bar 1 at 120 bpm (2 s), bar 2 at 60 bpm (4 s).
    expect(song.barTimes).toEqual([0, 2, 6]);
    expect(song.duration).toBe(6);
  });

  it('extends tied notes instead of re-attacking them', () => {
    const e = at(0)!;
    expect(e).toMatchObject({ pitch: 40, string: 0, fret: 0 });
    // Dotted quarter + tied eighth = 2 quarters = 1 s.
    expect(e.end).toBeCloseTo(1);
    expect(notes.filter((n) => n.pitch === 40)).toHaveLength(1);
  });

  it('times tuplets and repeated beats, and gives harmonics their sounding pitch', () => {
    // Triplet eighths after 2 quarters: 1/3 quarter each = 1/6 s.
    expect(at(1)).toMatchObject({ pitch: 47, fret: 2, hopo: true });
    const h = at(1 + 1 / 6)!;
    expect(h).toMatchObject({ fretPitch: 67, pitch: 67, harmonic: 'Natural' });
    // The same beat referenced twice is two notes.
    expect(at(1 + 2 / 6)).toMatchObject({ fretPitch: 67 });
  });

  it('merges voices, skips dead notes and places grace notes before the beat', () => {
    const bar2 = notes.filter((n) => n.bar === 1);
    expect(bar2.map((n) => n.pitch)).toEqual([43, 66, 64, 66]);
    expect(bar2.find((n) => n.grace)!.start).toBeCloseTo(3 - 0.125);
    expect(song.tracks[0].deadNotes).toBe(1);
    expect(bar2.find((n) => n.string === 5)!.letRing).toBe(true);
  });

  it('knows the natural harmonic intervals', () => {
    expect([12, 7, 5, 4, 9, 19, 24].map(harmonicInterval)).toEqual([12, 19, 24, 28, 28, 19, 24]);
  });
});
