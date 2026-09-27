/**
 * Playback of the original media and/or a synthesised rendering of the transcription,
 * exposing a single clock for the tab cursor. Slower practice speeds keep the original's
 * pitch (media element pitch correction) and re-render the synth at the slower tempo.
 */
import { synthesize, type SynthNote } from '../audio/synth';

export type Source = 'original' | 'synth' | 'both';

export class Player {
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
    if (this.playing && this.source !== 'original') this.restartSynth();
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
    if (this.source !== 'synth' && this.media) {
      this.media.playbackRate = this.rate;
      this.media.currentTime = at;
      this.media.muted = false;
      await this.media.play();
    }
    if (this.source !== 'original') this.startSynth(at);
    this.playing = true;
    this.onState(true);
    const tick = () => {
      if (!this.playing) return;
      const now = this.currentTime;
      if (now >= this.duration) {
        this.pause();
        return;
      }
      // Keep the synth locked to the media clock when both play.
      if (this.source === 'both' && this.ctx && performance.now() - this.lastDriftCheck > 1000) {
        this.lastDriftCheck = performance.now();
        const synthTime = this.synthOrigin.song + (this.ctx.currentTime - this.synthOrigin.ctx) * this.rate;
        if (Math.abs(synthTime - now) > 0.08) this.startSynth(now);
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
