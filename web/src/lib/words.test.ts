import { describe, expect, it } from 'vitest';
import { alike, mergeWords } from './words';

const merged = (old: string, now: string): string => mergeWords(old, now, (s) => `[-${s}-]`, (s) => `{+${s}+}`);

describe('what changed inside a line', () => {
  it('is the words only one of the two has, the old before the new, the rest left as it is', () => {
    expect(merged('Retries are unbounded for now.', 'Retries are capped at five for now.')).toBe('Retries are [-unbounded-]{+capped at five+} for now.');
  });

  it('is told a character at a time in Chinese, which has no spaces between its words', () => {
    expect(merged('目前系统会无限次重试，直到成功。', '目前系统最多重试五次，直到成功。')).toBe('目前系统[-会无限次-]{+最多+}重试{+五次+}，直到成功。');
  });

  it('is only what was put in, or taken out, when that is all that happened', () => {
    expect(merged('wait 250 between tries', 'wait 250 ms between tries')).toBe('wait 250 {+ms +}between tries');
    expect(merged('wait a little longer', 'wait longer')).toBe('wait [-a little -]longer');
  });

  it('says how alike two lines are, for telling a line changed from one replaced', () => {
    expect(alike('Retries are unbounded for now.', 'Retries are capped for now.')).toBeGreaterThan(0.6);
    expect(alike('The cache is never cleared.', 'Roll out to five percent first.')).toBeLessThan(0.3);
  });
});
