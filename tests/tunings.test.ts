import { describe, expect, it } from 'vitest';
import { ANY_TUNING, STANDARD_ANY_STRINGS, autoSelectTuning, resolveTuning, standardTuning, stringLabels, GUITAR_TUNINGS, BASS_TUNINGS } from '../src/music/tunings';

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
  it('defaults to standard tuning, choosing only the number of strings', () => {
    const line = [28, 31, 33, 35, 38, 40, 43, 45];
    expect(standardTuning('bass', line).id).toBe('standard');
    // Low C#1s only a 5-string's B string can play (as in a 5-string playthrough).
    expect(standardTuning('bass', [...line, ...line, ...line, 25, 25, 25]).id).toBe('fiveString');
    // A single stray low note isn't enough.
    expect(standardTuning('bass', [...line, 25]).id).toBe('standard');
    expect(standardTuning('guitar', [40, 45, 52, 36, 36]).id).toBe('sevenString');
    // Low Ds that "guess any tuning" reads as drop D stay in standard (7-string) tuning.
    const dropD = [38, 38, 45, 50, 38, 45, 50, 57];
    expect(resolveTuning('guitar', ANY_TUNING, dropD).tuning.id).toBe('dropD');
    expect(resolveTuning('guitar', STANDARD_ANY_STRINGS, dropD).tuning.id).toBe('sevenString');
    expect(resolveTuning('bass', 'fiveString', line)).toMatchObject({ tuning: { id: 'fiveString' }, automatic: false });
  });
  it('labels strings', () => {
    expect(stringLabels(GUITAR_TUNINGS[0])).toEqual(['E', 'A', 'D', 'G', 'B', 'e']);
    expect(stringLabels(BASS_TUNINGS[0])).toEqual(['E', 'A', 'D', 'G']);
  });
});
