/**
 * Analysis pipeline: audio → model activations → raw notes with features.
 * Environment-agnostic (used by the web worker and by the Node test-suite).
 */
import type { GraphModel } from '@tensorflow/tfjs-converter';
import { MODEL_SAMPLE_RATE, frameToTime, runBasicPitch, type ModelActivations } from './basicPitch';
import { computeNoteFeatures, estimateTuningCents, onsetEnvelope, refineOnsets } from './features';
import { decodeNotes } from './noteDecoding';
import { decodeOptionsFor, type AudioAnalysis, type RawNote, type Sensitivity } from './types';

export type ProgressFn = (stage: string, fraction: number) => void;

export class Analyzer {
  private activations: ModelActivations | null = null;
  private audio: Float32Array | null = null;
  private envelope: { envelope: Float32Array; rate: number } | null = null;

  constructor(
    private readonly model: GraphModel,
    readonly backend: string,
  ) {}

  /** Full analysis of mono audio at 22.05 kHz. */
  async analyze(audio: Float32Array, sensitivity: Sensitivity, onProgress: ProgressFn = () => {}): Promise<AudioAnalysis> {
    this.audio = audio;
    onProgress('Listening for notes', 0);
    this.activations = await runBasicPitch(this.model, audio, (f) => onProgress('Listening for notes', f));
    onProgress('Measuring rhythm', 0);
    this.envelope = onsetEnvelope(audio, MODEL_SAMPLE_RATE);
    onProgress('Measuring rhythm', 1);
    return this.redecode(sensitivity, onProgress);
  }

  /** Re-extract notes from cached model output with a different sensitivity (fast). */
  redecode(sensitivity: Sensitivity, onProgress: ProgressFn = () => {}): AudioAnalysis {
    if (!this.activations || !this.audio || !this.envelope) throw new Error('No audio has been analysed yet');
    onProgress('Extracting notes', 0);
    const frameNotes = decodeNotes(this.activations, decodeOptionsFor(sensitivity));
    const timed = refineOnsets(
      frameNotes.map((n) => ({
        pitch: n.pitch,
        start: frameToTime(n.startFrame),
        end: frameToTime(n.endFrame),
        amplitude: n.amplitude,
      })),
      this.envelope.envelope,
      this.envelope.rate,
    );
    onProgress('Analysing timbre', 0.5);
    const features = computeNoteFeatures(this.audio, MODEL_SAMPLE_RATE, timed);
    const notes: RawNote[] = timed.map((n, i) => ({ ...n, features: features[i] }));
    onProgress('Analysing timbre', 1);
    return {
      duration: this.audio.length / MODEL_SAMPLE_RATE,
      notes,
      onsetEnvelope: this.envelope.envelope,
      envelopeRate: this.envelope.rate,
      tuningCents: estimateTuningCents(notes),
      backend: this.backend,
    };
  }
}
