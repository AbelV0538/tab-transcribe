import { describe, expect, it } from 'vitest';
import { autoSelectTuning, stringLabels, GUITAR_TUNINGS, BASS_TUNINGS } from '../src/music/tunings';

describe('tuning selection', () => {
  it('defaults to standard', () => {
    expect(autoSelectTuning('guitar', [40, 45, 52, 55, 64]).id).toBe('standard');
    expect(autoSelectTuning('bass', [28, 33, 35, 40]).id).toBe('standard');
  });
  it('detects drop D from a low D', () => {
    expect(autoSelectTuning('guitar', [38, 38, 45, 50, 38, 45, 50, 57]).id).toBe('dropD');
  });
  it('detects E-flat standard', () => {
    expect(autoSelectTuning('guitar', [39, 44, 49, 39, 46, 51, 54]).id).toBe('eb');
  });
  it('detects 5-string bass', () => {
    expect(autoSelectTuning('bass', [23, 28, 30, 35, 23, 26]).id).toBe('fiveString');
  });
  it('labels strings', () => {
    expect(stringLabels(GUITAR_TUNINGS[0])).toEqual(['E', 'A', 'D', 'G', 'B', 'e']);
    expect(stringLabels(BASS_TUNINGS[0])).toEqual(['E', 'A', 'D', 'G']);
  });
});
