import './style.css';
import { Capacitor } from '@capacitor/core';
import { decodeFile } from './audio/decode';
import { EngineClient } from './engine/client';
import { MODEL_SAMPLE_RATE, type AudioAnalysis, type Sensitivity } from './engine/types';
import type { BackendPreference } from './engine/workerProtocol';
import { toMidi } from './export/midi';
import { toMusicXml } from './export/musicxml';
import { toTabText } from './export/text';
import { DEFAULT_SETTINGS, interpret, type InterpretSettings, type Transcription } from './music/interpret';
import { BASS_TUNINGS, GUITAR_TUNINGS, type InstrumentKind } from './music/tunings';
import { saveFile } from './platform/save';
import { PianoRoll } from './ui/pianoRoll';
import { Player, type Source } from './ui/player';
import { TabView } from './ui/tabView';

interface AppSettings extends InterpretSettings {
  sensitivity: Sensitivity;
  backend: BackendPreference;
}

const STORAGE_KEY = 'tab-transcribe.settings.v1';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  fileInput: $<HTMLInputElement>('fileInput'),
  drop: $<HTMLLabelElement>('drop'),
  dropTitle: $('dropTitle'),
  dropHint: $('dropHint'),
  form: $<HTMLFormElement>('settingsForm'),
  go: $<HTMLButtonElement>('goBtn'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  error: $('error'),
  results: $('results'),
  summary: $('summary'),
  mediaBox: $('mediaBox'),
  play: $<HTMLButtonElement>('playBtn'),
  playIcon: document.getElementById('playIcon') as unknown as SVGPathElement,
  seek: $<HTMLInputElement>('seek'),
  time: $('time'),
  sourceSeg: $('sourceSeg'),
  speed: $<HTMLSelectElement>('speed'),
  follow: $<HTMLInputElement>('follow'),
  trackSeg: $('trackSeg'),
  tabView: $('tabView'),
  roll: $<HTMLCanvasElement>('roll'),
  rollCard: $<HTMLDetailsElement>('rollCard'),
  about: $<HTMLDialogElement>('about'),
};

const state: {
  file: File | null;
  analysis: AudioAnalysis | null;
  analysedSensitivity: Sensitivity | null;
  transcription: Transcription | null;
  visible: InstrumentKind[];
  busy: boolean;
  settings: AppSettings;
} = {
  file: null,
  analysis: null,
  analysedSensitivity: null,
  transcription: null,
  visible: [],
  busy: false,
  settings: loadSettings(),
};

const engine = new EngineClient();
const tabView = new TabView(els.tabView, (t) => player.seek(t));
const roll = new PianoRoll(els.roll);
const player = new Player(
  els.mediaBox,
  (t) => {
    els.time.textContent = `${fmt(t)} / ${fmt(player.duration)}`;
    if (document.activeElement !== els.seek) els.seek.value = String(Math.round((t / Math.max(0.001, player.duration)) * 1000));
    tabView.setTime(t, els.follow.checked && player.isPlaying);
    if (els.rollCard.open) roll.setTime(t, player.isPlaying);
  },
  (playing) => {
    els.playIcon.setAttribute('d', playing ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M8 5v14l11-7z');
    els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  },
);

function fmt(sec: number): string {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function loadSettings(): AppSettings {
  const defaults: AppSettings = { ...DEFAULT_SETTINGS, sensitivity: 'normal', backend: 'auto' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    /* storage unavailable */
  }
}

// ---- Settings form -------------------------------------------------------------------

function fillTuningSelect(select: HTMLSelectElement, tunings: typeof GUITAR_TUNINGS) {
  select.replaceChildren(new Option('Auto-detect', 'auto'), ...tunings.map((t) => new Option(t.name, t.id)));
}
fillTuningSelect(els.form.elements.namedItem('guitarTuning') as HTMLSelectElement, GUITAR_TUNINGS);
fillTuningSelect(els.form.elements.namedItem('bassTuning') as HTMLSelectElement, BASS_TUNINGS);

function writeForm() {
  const s = state.settings;
  const set = (name: string, value: string) => ((els.form.elements.namedItem(name) as HTMLInputElement).value = value);
  set('instrumentMode', s.instrumentMode);
  set('guitarTuning', s.guitarTuning);
  set('bassTuning', s.bassTuning);
  set('capo', String(s.capo));
  set('sensitivity', s.sensitivity);
  set('bpm', s.bpm ? String(s.bpm) : '');
  set('beatsPerBar', String(s.beatsPerBar));
  set('subdivision', String(s.subdivision));
  set('backend', s.backend);
}

function readForm(): AppSettings {
  const get = (name: string) => (els.form.elements.namedItem(name) as HTMLInputElement).value;
  const bpm = parseFloat(get('bpm'));
  const sub = get('subdivision');
  return {
    instrumentMode: get('instrumentMode') as AppSettings['instrumentMode'],
    guitarTuning: get('guitarTuning'),
    bassTuning: get('bassTuning'),
    capo: Math.max(0, Math.min(12, Math.round(parseFloat(get('capo')) || 0))),
    sensitivity: get('sensitivity') as Sensitivity,
    bpm: Number.isFinite(bpm) && bpm >= 30 && bpm <= 300 ? bpm : null,
    beatsPerBar: parseInt(get('beatsPerBar'), 10) || 4,
    subdivision: sub === 'auto' ? 'auto' : (parseInt(sub, 10) as 3 | 4),
    backend: get('backend') as BackendPreference,
  };
}

let settingsTimer = 0;
els.form.addEventListener('change', () => {
  state.settings = readForm();
  saveSettings();
  if (!state.analysis || state.busy) return;
  clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(async () => {
    if (state.settings.sensitivity !== state.analysedSensitivity) {
      await runStep(async () => {
        state.analysis = await engine.redecode(state.settings.sensitivity, showProgress);
        state.analysedSensitivity = state.settings.sensitivity;
      });
    }
    reinterpret();
  }, 150);
});

// ---- File selection -----------------------------------------------------------------

function selectFile(file: File) {
  state.file = file;
  els.dropTitle.textContent = file.name;
  const mb = file.size / 1e6;
  els.dropHint.textContent = `${mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(file.size / 1e3)) + ' kB'} · tap to choose another file`;
  els.go.disabled = false;
  els.error.hidden = true;
  if (mb > 400) showError('This file is very large; decoding it may run out of memory on a phone. Trim the video if it fails.');
}

els.fileInput.addEventListener('change', () => {
  const f = els.fileInput.files?.[0];
  if (f) selectFile(f);
});
for (const type of ['dragenter', 'dragover'] as const) {
  els.drop.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop'] as const) els.drop.addEventListener(type, () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) selectFile(f);
});

// ---- Processing ---------------------------------------------------------------------

function showProgress(stage: string, fraction: number) {
  els.progress.hidden = false;
  els.progressFill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  els.progressText.textContent = fraction > 0 && fraction < 1 ? `${stage}… ${Math.round(fraction * 100)}%` : `${stage}…`;
}

function showError(message: string) {
  els.error.textContent = message;
  els.error.hidden = false;
}

async function runStep(fn: () => Promise<void>) {
  state.busy = true;
  els.go.disabled = true;
  els.error.hidden = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    state.busy = false;
    els.go.disabled = !state.file;
    els.progress.hidden = true;
  }
}

els.go.addEventListener('click', () => {
  const file = state.file;
  if (!file || state.busy) return;
  state.settings = readForm();
  saveSettings();
  // Create/resume audio inside the user gesture (needed by the decode fallback and playback).
  const ctx = player.audioContext();
  void ctx.resume().catch(() => {});
  void runStep(async () => {
    player.pause();
    const decoded = await decodeFile(file, MODEL_SAMPLE_RATE, showProgress, ctx);
    if (decoded.duration < 0.5) throw new Error('The recording is too short or has no audio track.');
    player.load(file, decoded.duration);
    state.analysis = await engine.analyze(decoded.samples, state.settings.sensitivity, state.settings.backend, showProgress);
    state.analysedSensitivity = state.settings.sensitivity;
    showProgress('Writing tabs', 1);
    reinterpret(true);
    els.results.hidden = false;
    els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

function reinterpret(resetVisible = false) {
  if (!state.analysis) return;
  const t = interpret(state.analysis, state.settings);
  state.transcription = t;
  const present = t.tracks.map((tr) => tr.instrument);
  if (resetVisible || state.visible.length === 0 || !state.visible.every((v) => present.includes(v))) state.visible = present.slice(0, 1);
  renderSummary(t);
  renderTrackSeg(t);
  tabView.render(t, state.visible);
  if (els.rollCard.open) roll.draw(state.analysis, t);
  player.setTranscription(
    t.tracks.flatMap((tr) => tr.notes.map((n) => ({ pitch: n.pitch, start: n.start, end: n.end, velocity: 0.4 + 0.6 * n.amplitude, instrument: tr.instrument }))),
  );
  tabView.setTime(player.currentTime, false);
}

function renderSummary(t: Transcription) {
  const chips: HTMLElement[] = [];
  const chip = (text: string, cls = '') => {
    const c = document.createElement('span');
    c.className = `chip ${cls}`;
    c.textContent = text;
    chips.push(c);
    return c;
  };
  const auto = t.settings.instrumentMode === 'auto';
  for (const kind of ['guitar', 'bass'] as const) {
    const d = t.detection[kind];
    const name = kind === 'guitar' ? 'Guitar' : 'Bass';
    const c = chip(
      d.present ? `${name}${auto ? ` · ${Math.round(d.confidence * 100)}% sure` : ''}` : `No ${name.toLowerCase()} detected`,
      d.present ? kind : 'off',
    );
    if (d.present) c.prepend(Object.assign(document.createElement('span'), { className: `dot ${kind}` }));
  }
  chip(`${t.grid.bpm} BPM · ${t.grid.beatsPerBar}/4${t.grid.subdivision === 3 ? ' · triplets' : ''}`);
  if (t.tuningCents !== null && Math.abs(t.tuningCents) >= 8) {
    chip(`Reference pitch A4 = ${(440 * 2 ** (t.tuningCents / 1200)).toFixed(1)} Hz`);
  }
  els.summary.replaceChildren(...chips);
}

function renderTrackSeg(t: Transcription) {
  const buttons: HTMLButtonElement[] = [];
  const options: Array<{ label: string; kinds: InstrumentKind[] }> = t.tracks.map((tr) => ({
    label: tr.instrument === 'guitar' ? 'Guitar' : 'Bass',
    kinds: [tr.instrument],
  }));
  if (t.tracks.length > 1) options.push({ label: 'Both', kinds: t.tracks.map((tr) => tr.instrument) });
  if (options.length > 1) {
    for (const o of options) {
      const b = document.createElement('button');
      b.textContent = o.label;
      b.className = o.kinds.join() === state.visible.join() ? 'on' : '';
      b.addEventListener('click', () => {
        state.visible = o.kinds;
        renderTrackSeg(t);
        tabView.render(t, state.visible);
        tabView.setTime(player.currentTime, false);
      });
      buttons.push(b);
    }
  }
  els.trackSeg.replaceChildren(...buttons);
}

// ---- Player controls ----------------------------------------------------------------

els.play.addEventListener('click', () => player.toggle());
els.seek.addEventListener('input', () => player.seek((Number(els.seek.value) / 1000) * player.duration));
els.speed.addEventListener('change', () => player.setRate(Number(els.speed.value)));
els.sourceSeg.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  for (const x of els.sourceSeg.querySelectorAll('button')) x.classList.toggle('on', x === b);
  player.setSource(b.dataset.source as Source);
});
els.rollCard.addEventListener('toggle', () => {
  if (els.rollCard.open && state.analysis && state.transcription) {
    roll.draw(state.analysis, state.transcription);
    roll.setTime(player.currentTime, true);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !els.results.hidden && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    player.toggle();
  }
});

// ---- Export ---------------------------------------------------------------------------

function baseName(): string {
  return (state.file?.name ?? 'transcription').replace(/\.[^.]+$/, '') || 'transcription';
}

async function exportWith(fn: (t: Transcription, name: string) => Promise<void>) {
  const t = state.transcription;
  if (!t || t.tracks.length === 0) return showError('Nothing to export yet.');
  try {
    await fn(t, baseName());
  } catch (err) {
    showError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
$('exportTxt').addEventListener('click', () => exportWith((t, n) => saveFile(`${n} - tab.txt`, toTabText(t, n), 'text/plain')));
$('exportMidi').addEventListener('click', () => exportWith((t, n) => saveFile(`${n}.mid`, toMidi(t, n), 'audio/midi')));
$('exportXml').addEventListener('click', () => exportWith((t, n) => saveFile(`${n}.musicxml`, toMusicXml(t, n), 'application/vnd.recordare.musicxml+xml')));

$('aboutBtn').addEventListener('click', () => els.about.showModal());

writeForm();

// Offline support for the web build (the native app bundles everything already).
if ('serviceWorker' in navigator && import.meta.env.PROD && !Capacitor.isNativePlatform() && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
