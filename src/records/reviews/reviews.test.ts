import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { listReviews, readReview, writeReview } from './index.js';

beforeEach(() => {
  mkYanHome(mkTempDir());
});

afterAll(cleanupTempDirs);

const AT = new Date('2026-11-11T14:03:12Z');

describe('a review', () => {
  it('is a file of its own, the word on it all first, then each comment numbered under where it is, with what was selected', () => {
    const kept = writeReview('t042', {
      summary: 'Close, two things to fix.',
      comments: [
        { where: 'artifacts/docs/design.md, line 12', quote: 'retries are\nunbounded', text: 'Cap them at five.' },
        { where: 'app, branch feat/retry, src/retry.ts, lines 40-41', quote: 'const n = 1;\nlet s = `a``b`;', text: 'Why 1?', code: true },
        { where: 'artifacts/docs/design.md, line 30', quote: '', text: 'This part is missing a diagram.' },
      ],
    }, AT);
    expect(kept).toMatchObject({ name: '20261111-140312.md', path: 'tasks/t042/reviews/20261111-140312.md' });
    const text = readFileSync(kept.file, 'utf8');
    expect(text).toMatch(/^# Review of t042, /);
    expect(text.split('\n').slice(2).join('\n')).toBe([
      'Close, two things to fix.',
      '',
      '## 1. artifacts/docs/design.md, line 12',
      '',
      '> retries are',
      '> unbounded',
      '',
      'Cap them at five.',
      '',
      '## 2. app, branch feat/retry, src/retry.ts, lines 40-41',
      '',
      '```',
      'const n = 1;',
      'let s = `a``b`;',
      '```',
      '',
      'Why 1?',
      '',
      '## 3. artifacts/docs/design.md, line 30',
      '',
      'This part is missing a diagram.',
      '',
    ].join('\n'));
  });

  it('is never written over: a second in the same second is another file, and the newest is the one read', () => {
    const one = writeReview('t042', { summary: 'first', comments: [] }, AT);
    const two = writeReview('t042', { summary: 'second', comments: [] }, AT);
    const later = writeReview('t042', { summary: 'third', comments: [] }, new Date('2026-11-12T08:00:00Z'));
    expect(listReviews('t042')).toEqual([one.name, two.name, later.name]);
    expect(readReview('t042')?.text).toContain('third');
    expect(readReview('t042', '20261111-140312')?.text).toContain('first');
    expect(readReview('t042', 'nope')).toBeUndefined();
  });

  it('says something, of somewhere', () => {
    expect(() => writeReview('t042', { summary: ' ', comments: [] })).toThrow(/says something/);
    expect(() => writeReview('t042', { summary: '', comments: [{ where: 'a.md', quote: 'x', text: ' ' }] })).toThrow(/every comment/);
    expect(listReviews('t042')).toEqual([]);
    expect(readReview('t042')).toBeUndefined();
  });
});
