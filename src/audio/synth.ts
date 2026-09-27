/**
 * Karplus-Strong plucked-string synthesis, used to play back a transcription so it can be
 * compared by ear with the original (and to generate test recordings).
 * Guitar: bright noise excitation plucked near the bridge (overtone-rich).
 * Bass: triangular finger-pluck excitation (dominant fundamental) and longer sustain.
 */
export interface SynthNote {
  pitch: number;
  start: number;
  end: number;
  velocity?: number;
  instrument: 'guitar' | 'bass';
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export function synthesize(notes: SynthNote[], duration: number, sampleRate = 22050, seed = 7): Float32Array {
  const out = new Float32Array(Math.ceil(duration * sampleRate));
  const rand = rng(seed);
  for (const n of notes) {
    const f0 = 440 * 2 ** ((n.pitch - 69) / 12);
    const loop = sampleRate / f0 - 0.5; // averaging filter adds half a sample
    const nInt = Math.max(2, Math.floor(loop));
    const frac = loop - nInt;
    const c = (1 - frac) / (1 + frac); // all-pass fractional delay
    const t60 = n.instrument === 'bass' ? 3.5 : 2.5;
    const g = Math.pow(0.001, 1 / (f0 * t60));

    // Excitation.
    const line = new Float64Array(nInt);
    for (let i = 0; i < nInt; i++) line[i] = rand();
    if (n.instrument === 'bass') {
      // Finger pluck: triangular displacement (harmonics fall as 1/n^2) plus a little noise.
      const apex = Math.round(nInt * 0.3);
      for (let i = 0; i < nInt; i++) {
        const tri = i < apex ? i / apex : (nInt - i) / (nInt - apex);
        line[i] = tri + 0.08 * line[i];
      }
    } else {
      // Pluck position comb (1/6 of the string) for a guitar-like spectrum.
      const d = Math.max(1, Math.round(nInt / 6));
      const copy = Float64Array.from(line);
      for (let i = 0; i < nInt; i++) line[i] = copy[i] - (i >= d ? copy[i - d] : 0);
    }
    let mean = 0;
    for (let i = 0; i < nInt; i++) mean += line[i] / nInt;
    let peak = 1e-9;
    for (let i = 0; i < nInt; i++) {
      line[i] -= mean;
      peak = Math.max(peak, Math.abs(line[i]));
    }
    const amp = (n.velocity ?? 0.8) * (n.instrument === 'bass' ? 0.45 : 0.35);
    for (let i = 0; i < nInt; i++) line[i] *= amp / peak;

    const s0 = Math.round(n.start * sampleRate);
    const s1 = Math.min(out.length, Math.round((n.end + 0.05) * sampleRate));
    const release = Math.round(0.03 * sampleRate);
    const endSample = Math.round(n.end * sampleRate);
    let idx = 0;
    let prev = 0;
    let apIn = 0;
    let apOut = 0;
    for (let s = s0; s < s1; s++) {
      const y = line[idx];
      const avg = g * 0.5 * (y + prev);
      const ap = c * avg + apIn - c * apOut;
      apIn = avg;
      apOut = ap;
      prev = y;
      line[idx] = ap;
      idx = idx + 1 === nInt ? 0 : idx + 1;
      const env = s < endSample ? 1 : Math.max(0, 1 - (s - endSample) / release);
      out[s] += y * env;
    }
  }
  return out;
}
