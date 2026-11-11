import { describe, expect, it } from 'vitest';
import { parsePatch } from './patch';
import { markWords, wordDiff } from './words';

describe('what changed inside a line', () => {
  it('is the words only one of the two has, the rest left as it is', () => {
    expect(wordDiff('Retries are unbounded for now.', 'Retries are capped at five for now.')).toEqual([
      'Retries are <del>unbounded</del> for now.',
      'Retries are <ins>capped at five</ins> for now.',
    ]);
  });

  it('is told a character at a time in Chinese, which has no spaces between its words', () => {
    expect(wordDiff('目前系统会无限次重试，直到成功。', '目前系统最多重试五次，直到成功。')).toEqual([
      '目前系统<del>会无限次</del>重试，直到成功。',
      '目前系统<ins>最多</ins>重试<ins>五次</ins>，直到成功。',
    ]);
  });

  it('is written as text, whatever the line holds', () => {
    expect(wordDiff('a <b> c', 'a <i> c')?.[1]).toBe('a &lt;<ins>i</ins>&gt; c');
  });

  it('is not marked between two lines with little in common', () => {
    expect(wordDiff('The cache is never cleared.', 'Roll out to five percent first.')).toBeNull();
  });

  it('is marked in a diff where a line took the place of another, and nowhere else', () => {
    const [f] = parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n same\n-wait 250 between tries\n+wait 250 ms between tries\n+a new line\n');
    if (f === undefined) throw new Error('no file');
    markWords(f);
    expect(f.hunks[0]?.lines.map((l) => l.h ?? null)).toEqual([null, 'wait 250 between tries', 'wait 250 <ins>ms </ins>between tries', null]);
  });
});
