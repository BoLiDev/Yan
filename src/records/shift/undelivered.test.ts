import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir } from '../../../tests/helpers/fixtures.js';
import { clearUndelivered, readUndelivered, recordUndelivered, undeliveredFile } from './undelivered.js';

/**
 * `run/undelivered`, on its own: the line format a report is written in, and
 * how a reader copes with a line it did not write.
 */

afterAll(cleanupTempDirs);

const NOW = Date.UTC(2026, 8, 11, 8, 0, 0);

describe('recording', () => {
  it('appends one line per report, in epoch seconds, creating run/ if it has to', () => {
    const run = join(mkTempDir(), 'run');
    recordUndelivered(run, 'blocked', 'which header wins', NOW);
    recordUndelivered(run, 'done', 'mr https://example.invalid/88', NOW + 61_500);
    expect(readFileSync(undeliveredFile(run), 'utf8')).toBe(
      `${NOW / 1000} blocked which header wins\n${NOW / 1000 + 61} done mr https://example.invalid/88\n`,
    );
  });

  it('swallows a write that cannot happen', () => {
    const blocker = join(mkTempDir(), 'run');
    writeFileSync(blocker, 'a file where the directory should be\n');
    expect(() => recordUndelivered(blocker, 'blocked', 'x', NOW)).not.toThrow();
  });
});

describe('reading', () => {
  it('keeps the spaces inside a note', () => {
    const run = join(mkTempDir(), 'run');
    recordUndelivered(run, 'needs-decision', 'keep  two spaces, and a trailing one ', NOW);
    expect(readUndelivered(run)).toEqual([
      { at: NOW / 1000, state: 'needs-decision', note: 'keep  two spaces, and a trailing one ' },
    ]);
  });

  it('reads a stamp that is not a number as 0, and keeps the rest of the line', () => {
    const run = mkTempDir();
    writeFileSync(undeliveredFile(run), 'yesterday blocked the auth fixture\n\n1757577600 conflict src/cli/state.ts\r\n');
    expect(readUndelivered(run)).toEqual([
      { at: 0, state: 'blocked', note: 'the auth fixture' },
      { at: 1757577600, state: 'conflict', note: 'src/cli/state.ts' },
    ]);
  });

  it('is none when there is no file', () => {
    expect(readUndelivered(join(mkTempDir(), 'run'))).toEqual([]);
  });
});

describe('clearing', () => {
  it('removes the file, and is quiet when there is none', () => {
    const run = mkTempDir();
    recordUndelivered(run, 'blocked', 'x', NOW);
    clearUndelivered(run);
    expect(existsSync(undeliveredFile(run))).toBe(false);
    expect(() => clearUndelivered(run)).not.toThrow();
  });
});
