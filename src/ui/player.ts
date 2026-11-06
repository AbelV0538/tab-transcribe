/**
 * Playback of the original media and/or a synthesised rendering of the transcription,
 * exposing a single clock for the tab cursor. Slower practice speeds keep the original's
 * pitch (media element pitch correction) and re-render the synth at the slower tempo.
 */
import { synthesize, type SynthNote } from '../audio/synth';
import { encodeWav } from '../audio/wav';

/** What to listen to; the stem sources play an isolated instrument from the separation. */
export type Source = 'original' | 'synth' | 'both' | 'guitarStem' | 'bassStem';

export type StemKind = 'guitar' | 'bass';

export class Player {
  /** Separated stems, played through their own (hidden) media elements so slow speeds keep the pitch. */
  private stems = new Map<StemKind, { url: string; el: HTMLAudioElement }>();
  private media: HTMLMediaElement | null = null;
  private url: string | null = null;
  private ctx: AudioContext | null = null;
  private synthNotes: SynthNote[] = [];
  private synthBuffer: AudioBuffer | null = null;
  private synthRate = 0;
  private synthNode: AudioBufferSourceNode | null = null;
  /** Song time at which the synth node started, and the context time it started at. */
  private synthOrigin = { song: 0, ctx: 0 };
  private playing = false;
  private position = 0;
  private raf = 0;
  private lastDriftCheck = 0;
  source: Source = 'original';
  rate = 1;
  duration = 0;

  constructor(
    private readonly box: HTMLElement,
    private readonly onTime: (t: number) => void,
    private readonly onState: (playing: boolean) => void,
  ) {}

  /** The shared AudioContext (created on first use, inside a user gesture where possible). */
  audioContext(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  load(file: File, duration: number): void {
    this.stop();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.duration = duration;
    const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|3gp)$/i.test(file.name);
    const el = document.createElement(isVideo ? 'video' : 'audio');
    el.src = this.url;
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    (el as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = true;
    el.addEventListener('ended', () => this.pause());
    if (isVideo) el.addEventListener('click', () => this.toggle());
    this.box.replaceChildren(...(isVideo ? [el] : []));
    this.media = el;
    this.position = 0;
    this.onTime(0);
  }

  setTranscription(notes: SynthNote[]): void {
    this.synthNotes = notes;
    this.synthBuffer = null;
    if (this.playing && this.synthOn) this.restartSynth();
  }

  /** Make the separated stems (mono PCM at `sampleRate`) available as sources, or remove them. */
  setStems(stems: Record<StemKind, Float32Array> | null, sampleRate: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    for (const s of this.stems.values()) {
      s.el.pause();
      s.el.removeAttribute('src');
      URL.revokeObjectURL(s.url);
    }
    this.stems.clear();
    if (stems) {
      for (const kind of ['guitar', 'bass'] as const) {
        const url = URL.createObjectURL(new Blob([encodeWav(stems[kind], sampleRate) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
        const el = document.createElement('audio');
        el.src = url;
        el.preload = 'auto';
        (el as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = true;
        this.stems.set(kind, { url, el });
      }
    } else if (this.source === 'guitarStem' || this.source === 'bassStem') {
      this.source = 'original';
    }
    if (wasPlaying) void this.play();
  }

  get hasStems(): boolean {
    return this.stems.size > 0;
  }

  private get synthOn(): boolean {
    return this.source === 'synth' || this.source === 'both';
  }

  private stemElement(): HTMLAudioElement | null {
    if (this.source === 'guitarStem') return this.stems.get('guitar')?.el ?? null;
    if (this.source === 'bassStem') return this.stems.get('bass')?.el ?? null;
    return null;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentTime(): number {
    if (!this.playing) return this.position;
    if (this.source !== 'synth' && this.media) return this.media.currentTime;
    if (this.ctx && this.synthNode) return this.synthOrigin.song + (this.ctx.currentTime - this.synthOrigin.ctx) * this.rate;
    return this.position;
  }

  private buffer(): AudioBuffer | null {
    const ctx = this.audioContext();
    if (this.synthBuffer && this.synthRate === this.rate) return this.synthBuffer;
    if (this.synthNotes.length === 0) return null;
    // Render at the playback speed so slowed-down playback keeps its pitch.
    const scaled = this.synthNotes.map((n) => ({ ...n, start: n.start / this.rate, end: n.end / this.rate }));
    const samples = synthesize(scaled, this.duration / this.rate + 1, ctx.sampleRate);
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    this.synthBuffer = buf;
    this.synthRate = this.rate;
    return buf;
  }

  private startSynth(at: number) {
    const ctx = this.audioContext();
    const buf = this.buffer();
    this.stopSynth();
    if (!buf) return;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = this.source === 'both' ? 0.6 : 0.9;
    node.connect(gain).connect(ctx.destination);
    node.start(0, Math.max(0, at / this.rate));
    this.synthNode = node;
    this.synthOrigin = { song: at, ctx: ctx.currentTime };
  }

  private stopSynth() {
    if (this.synthNode) {
      try {
        this.synthNode.stop();
      } catch {
        /* already stopped */
      }
      this.synthNode.disconnect();
      this.synthNode = null;
    }
  }

  private restartSynth() {
    this.startSynth(this.currentTime);
  }

  async play(): Promise<void> {
    if (this.playing) return;
    const ctx = this.audioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const at = this.position >= this.duration - 0.05 ? 0 : this.position;
    const stem = this.stemElement();
    if (this.source !== 'synth' && this.media) {
      // With a stem playing, the original runs muted as the clock (and keeps a video moving).
      this.media.playbackRate = this.rate;
      this.media.currentTime = at;
      this.media.muted = !!stem;
      await this.media.play();
    }
    if (stem) {
      stem.playbackRate = this.rate;
      stem.currentTime = at;
      await stem.play();
    }
    if (this.synthOn) this.startSynth(at);
    this.playing = true;
    this.onState(true);
    const tick = () => {
      if (!this.playing) return;
      const now = this.currentTime;
      if (now >= this.duration) {
        this.pause();
        return;
      }
      // Keep the synth or the stem locked to the media clock.
      if (performance.now() - this.lastDriftCheck > 1000) {
        this.lastDriftCheck = performance.now();
        if (this.source === 'both' && this.ctx) {
          const synthTime = this.synthOrigin.song + (this.ctx.currentTime - this.synthOrigin.ctx) * this.rate;
          if (Math.abs(synthTime - now) > 0.08) this.startSynth(now);
        }
        if (stem && Math.abs(stem.currentTime - now) > 0.08) stem.currentTime = now;
      }
      this.onTime(now);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    if (!this.playing) return;
    this.position = Math.min(this.duration, this.currentTime);
    this.stop();
    this.onTime(this.position);
  }

  private stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.media?.pause();
    for (const s of this.stems.values()) s.el.pause();
    this.stopSynth();
    this.onState(false);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(time: number): void {
    const t = Math.max(0, Math.min(this.duration, time));
    const wasPlaying = this.playing;
    if (wasPlaying) this.stop();
    this.position = t;
    if (this.media) this.media.currentTime = t;
    this.onTime(t);
    if (wasPlaying) void this.play();
  }

  setSource(source: Source): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.source = source;
    if (wasPlaying) void this.play();
  }

  setRate(rate: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.rate = rate;
    if (wasPlaying) void this.play();
  }
}
