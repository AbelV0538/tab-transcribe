/** Shared data types for the analysis engine (worker) and the interpretation layer. */

/** Sample rate the note-detection model expects. */
export const MODEL_SAMPLE_RATE = 22050;

/** Spectral / envelope descriptors measured on the audio around one detected note. */
export interface NoteFeatures {
  /**
   * Fundamental dominance: energy of the 1st harmonic divided by the energy of harmonics 1..8.
   * Bass guitar tends to have a strong fundamental; guitar low notes are dominated by overtones.
   * `null` when the note was too short or too quiet to measure.
   */
  fundamentalDominance: number | null;
  /** Energy-weighted mean harmonic number (1 = pure sine). `null` when not measurable. */
  harmonicCentroid: number | null;
  /** Ratio of RMS just after vs just before the onset (a plucked attack gives a large value). */
  attack: number;
  /**
   * Height of the onset-envelope peak at the note start relative to the strongest onset
   * within ±250 ms (0..1). Low values mean no clear pluck, e.g. a detector fragment.
   */
  onsetStrength: number;
  /** Deviation in cents of the measured pitch from the equal-tempered pitch, if measurable. */
  cents: number | null;
}

/** A note as detected by the neural transcription model (instrument-agnostic). */
export interface RawNote {
  /** MIDI pitch number (e.g. 40 = E2, the low E string of a guitar). */
  pitch: number;
  /** Onset time in seconds. */
  start: number;
  /** Offset time in seconds. */
  end: number;
  /** Mean model activation over the note, 0..1. */
  amplitude: number;
  features: NoteFeatures;
}

export type Sensitivity = 'low' | 'normal' | 'high';

export interface NoteDecodeOptions {
  /** Minimum onset activation for a new note. */
  onsetThreshold: number;
  /** Minimum frame activation to keep a note sounding. */
  frameThreshold: number;
  /** Minimum note length, in model frames (~11.6 ms each). */
  minNoteFrames: number;
  /** Lowest MIDI pitch to keep. */
  minPitch: number;
  /** Highest MIDI pitch to keep. */
  maxPitch: number;
  /** Add onsets where frame activations jump even without an onset activation. */
  inferOnsets: boolean;
  /** Recover notes from leftover frame energy that had no onset ("melodia trick"). */
  melodiaTrick: boolean;
  /** Frames a note may dip below threshold before it is ended. */
  energyTolerance: number;
}

export const SENSITIVITY_PRESETS: Record<Sensitivity, Pick<NoteDecodeOptions, 'onsetThreshold' | 'frameThreshold' | 'minNoteFrames'>> = {
  low: { onsetThreshold: 0.6, frameThreshold: 0.35, minNoteFrames: 7 },
  normal: { onsetThreshold: 0.5, frameThreshold: 0.3, minNoteFrames: 5 },
  high: { onsetThreshold: 0.35, frameThreshold: 0.22, minNoteFrames: 4 },
};

export function decodeOptionsFor(sensitivity: Sensitivity): NoteDecodeOptions {
  return {
    ...SENSITIVITY_PRESETS[sensitivity],
    // B0 (lowest note of a 5-string bass) up to F#6 (just above the 24th fret of a guitar).
    minPitch: 23,
    maxPitch: 90,
    inferOnsets: true,
    melodiaTrick: true,
    energyTolerance: 11,
  };
}

/** Everything the interpretation layer needs from one analysed recording. */
export interface AudioAnalysis {
  /** Length of the recording in seconds. */
  duration: number;
  notes: RawNote[];
  /** Onset-strength envelope (spectral flux), used for tempo and beat tracking. */
  onsetEnvelope: Float32Array;
  /** Frames per second of `onsetEnvelope`. */
  envelopeRate: number;
  /** Median tuning deviation of the recording in cents relative to A4 = 440 Hz. */
  tuningCents: number | null;
  /** Which TensorFlow.js backend ran the model. */
  backend: string;
}
