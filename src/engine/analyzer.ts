/**
 * Analysis pipeline: audio → model activations → raw notes with features.
 * Environment-agnostic (used by the web worker and by the Node test-suite).
 *
 * Without separation, the note model listens to the whole mix. With separated stems it
 * listens to the guitar and the bass stem separately, and every note is tagged with its stem;
 * onsets and timbre are then measured on that stem too. Tempo and beats always come from the
 * full mix, where the drums are.
 */
import type { GraphModel } from '@tensorflow/tfjs-converter';
import type { InstrumentStems } from '../separation/stems';
import { MODEL_SAMPLE_RATE, frameToTime, runBasicPitch, type ModelActivations } from './basicPitch';
import { computeNoteFeatures, estimateTuningCents, harmonicEnergy, onsetEnvelope, refineOnsets } from './features';
import { decodeNotes } from './noteDecoding';
import { decodeOptionsFor, type AudioAnalysis, type NoteStem, type RawNote, type Sensitivity } from './types';

export type ProgressFn = (stage: string, fraction: number) => void;

type Envelope = { envelope: Float32Array; rate: number };

interface Source {
  /** Undefined for the full mix. */
  stem?: NoteStem;
  audio: Float32Array;
  activations: ModelActivations;
  /** Onset envelope used to refine this source's note onsets. */
  envelope: Envelope;
}

export class Analyzer {
  private sources: Source[] = [];
  private audio: Float32Array | null = null;
  private envelope: Envelope | null = null;

  constructor(
    private readonly model: GraphModel,
    readonly backend: string,
  ) {}

  /**
   * Full analysis of mono audio at 22.05 kHz. With `stems` (same rate and length), notes are
   * detected in the guitar and bass stems instead of the mix.
   */
  async analyze(audio: Float32Array, sensitivity: Sensitivity, onProgress: ProgressFn = () => {}, stems?: InstrumentStems): Promise<AudioAnalysis> {
    this.audio = audio;
    this.sources = [];
    const inputs: Array<{ stem?: NoteStem; audio: Float32Array; label: string }> = stems
      ? [
          { stem: 'guitar', audio: stems.guitar, label: 'Listening for guitar notes' },
          { stem: 'bass', audio: stems.bass, label: 'Listening for bass notes' },
        ]
      : [{ audio, label: 'Listening for notes' }];
    onProgress('Measuring rhythm', 0);
    this.envelope = onsetEnvelope(audio, MODEL_SAMPLE_RATE);
    for (const input of inputs) {
      onProgress(input.label, 0);
      const activations = await runBasicPitch(this.model, input.audio, (f) => onProgress(input.label, f));
      const envelope = input.stem ? onsetEnvelope(input.audio, MODEL_SAMPLE_RATE) : this.envelope;
      this.sources.push({ stem: input.stem, audio: input.audio, activations, envelope });
    }
    return this.redecode(sensitivity, onProgress);
  }

  /** Re-extract notes from cached model output with a different sensitivity (fast). */
  redecode(sensitivity: Sensitivity, onProgress: ProgressFn = () => {}): AudioAnalysis {
    if (!this.sources.length || !this.audio || !this.envelope) throw new Error('No audio has been analysed yet');
    onProgress('Extracting notes', 0);
    const options = decodeOptionsFor(sensitivity);
    const notes: RawNote[] = [];
    this.sources.forEach((src, k) => {
      const frameNotes = decodeNotes(src.activations, options);
      const timed = refineOnsets(
        frameNotes.map((n) => ({
          pitch: n.pitch,
          start: frameToTime(n.startFrame),
          end: frameToTime(n.endFrame),
          amplitude: n.amplitude,
        })),
        src.envelope.envelope,
        src.envelope.rate,
      );
      onProgress('Analysing timbre', (k + 0.5) / this.sources.length);
      const features = computeNoteFeatures(src.audio, MODEL_SAMPLE_RATE, timed);
      const mix = this.audio!;
      timed.forEach((n, i) => {
        if (!src.stem) {
          notes.push({ ...n, features: features[i] });
          return;
        }
        // The note model hears quiet audio as well as loud, so a stem's faint leftovers of
        // another instrument would become notes: measure how much of the note is in the stem.
        const inStem = harmonicEnergy(src.audio, MODEL_SAMPLE_RATE, n.pitch, n.start);
        const inMix = harmonicEnergy(mix, MODEL_SAMPLE_RATE, n.pitch, n.start);
        const stemShare = inMix > 0 ? Math.sqrt(inStem / inMix) : 0;
        notes.push({ ...n, features: { ...features[i], stemShare }, stem: src.stem });
      });
    });
    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    onProgress('Analysing timbre', 1);
    const separated = this.sources.some((s) => s.stem);
    return {
      duration: this.audio.length / MODEL_SAMPLE_RATE,
      notes,
      onsetEnvelope: this.envelope.envelope,
      envelopeRate: this.envelope.rate,
      tuningCents: estimateTuningCents(notes),
      backend: this.backend,
      ...(separated ? { separated } : {}),
    };
  }
}
