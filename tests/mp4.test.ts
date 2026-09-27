import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAudioSpecificConfig, probeMp4, type Mp4AudioTrack } from '../src/audio/mp4';
import { encodeWav } from './helpers/synth';

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));

function audioTrack(name: string): Mp4AudioTrack {
  const probe = probeMp4(fixture(name));
  if (probe.kind !== 'audio') throw new Error(`expected an audio track, got ${probe.kind}`);
  return probe.track;
}

// Fixtures (tests/fixtures) were made with ffmpeg from the synthesised bass line in helpers/synth:
//   bass-aac.mp4             64x64 H.264 video + AAC-LC mono audio, 9 s
//   bass-aac-fragmented.mp4  first 3 s of it remuxed with -movflags frag_keyframe+empty_moov+default_base_moof
//   silent-aac.mp4           3 s video + silent AAC track;  video-only.mp4  no audio track
// Expected offsets and sizes come from `ffprobe -show_entries packet=size,pos`.
describe('MP4 audio demuxer', () => {
  it('reads the AAC track of a regular MP4 (interleaved with video)', () => {
    const t = audioTrack('bass-aac.mp4');
    expect(t).toMatchObject({ codec: 'mp4a.40.2', format: 'AAC-LC', sampleRate: 44100, channels: 1, timescale: 44100, startTime: 1024 });
    expect(t.description).toBeInstanceOf(Uint8Array);
    expect(t.samples).toHaveLength(389);
    expect(t.samples[0]).toMatchObject({ offset: 4852, size: 19, time: 0, duration: 1024 });
    expect(t.samples[1]).toMatchObject({ offset: 4884, size: 4, time: 1024 });
    expect(t.samples.at(-1)).toMatchObject({ offset: 72935, size: 4 });
  });

  it('reads a fragmented MP4 (moof/trun)', () => {
    const t = audioTrack('bass-aac-fragmented.mp4');
    expect(t.codec).toBe('mp4a.40.2');
    expect(t.samples).toHaveLength(131);
    expect(t.samples[0]).toMatchObject({ offset: 2303, size: 19 });
    expect(t.samples[1]).toMatchObject({ offset: 2322, size: 4 });
    expect(t.samples.at(-1)).toMatchObject({ offset: 26740, size: 154 });
  });

  it('reports a video without an audio track', () => {
    expect(probeMp4(fixture('video-only.mp4')).kind).toBe('no-audio');
  });

  it('rejects non-MP4 data', () => {
    expect(probeMp4(encodeWav(new Float32Array(1000), 22050)).kind).toBe('not-mp4');
    expect(probeMp4(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 2, 3])).kind).toBe('not-mp4');
  });
});

describe('AudioSpecificConfig', () => {
  it('parses AAC-LC', () => {
    expect(parseAudioSpecificConfig(new Uint8Array([0x12, 0x10]))).toEqual({ objectType: 2, sampleRate: 44100, channels: 2 });
  });
  it('parses explicitly signalled HE-AAC (SBR)', () => {
    // AOT 5, 22.05 kHz core, stereo, SBR output at 44.1 kHz, core AOT 2.
    expect(parseAudioSpecificConfig(new Uint8Array([0x2b, 0x92, 0x08, 0x00]))).toEqual({ objectType: 5, sampleRate: 22050, channels: 2, extensionSampleRate: 44100 });
  });
  it('rejects truncated configs', () => {
    expect(parseAudioSpecificConfig(new Uint8Array([0x12]))).toBeNull();
  });
});
