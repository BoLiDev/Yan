import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir } from '../../../tests/helpers/fixtures.js';
import {
  appendEvent,
  clearUndelivered,
  lastEvent,
  parseEventLine,
  readUndelivered,
  recordUndelivered,
  undeliveredFile,
} from './events.js';

/**
 * The line both `run/status` and `run/undelivered` are written in, and
 * `run/undelivered` on its own: how a reader copes with a line it did not
 * write, and with one in the format the queue had before.
 */

afterAll(cleanupTempDirs);

const NOW = new Date(Date.UTC(2026, 8, 11, 8, 0, 0));

describe('one line', () => {
  it('is the moment, the state and the rest of the line as the note, tabs included', () => {
    expect(parseEventLine('2026-09-11T08:00:00Z\tblocked\tpaths\tthat carry a tab')).toEqual({
      at: '2026-09-11T08:00:00Z',
      state: 'blocked',
      note: 'paths\tthat carry a tab',
    });
  });

  it('reads the fields a line lacks as empty', () => {
    expect(parseEventLine('2026-09-11T08:00:00Z\tdone')).toEqual({ at: '2026-09-11T08:00:00Z', state: 'done', note: '' });
  });

  it('is the same in both files', () => {
    const run = join(mkTempDir(), 'run');
    appendEvent(run, 'blocked', 'which header wins');
    recordUndelivered(run, 'blocked', 'which header wins');
    const line = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\tblocked\twhich header wins\n$/;
    expect(readFileSync(join(run, 'status'), 'utf8')).toMatch(line);
    expect(readFileSync(undeliveredFile(run), 'utf8')).toMatch(line);
    expect(readUndelivered(run)).toEqual([lastEvent(run)]);
  });
});

describe('recording', () => {
  it('appends one line per report, creating run/ if it has to', () => {
    const run = join(mkTempDir(), 'run');
    recordUndelivered(run, 'blocked', 'which header wins', NOW);
    recordUndelivered(run, 'done', 'mr https://example.invalid/88', new Date(NOW.getTime() + 61_500));
    expect(readFileSync(undeliveredFile(run), 'utf8')).toBe(
      '2026-09-11T08:00:00Z\tblocked\twhich header wins\n2026-09-11T08:01:01Z\tdone\tmr https://example.invalid/88\n',
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
      { at: '2026-09-11T08:00:00Z', state: 'needs-decision', note: 'keep  two spaces, and a trailing one ' },
    ]);
  });

  it('keeps a moment that is not one as written, and skips blank lines', () => {
    const run = mkTempDir();
    writeFileSync(undeliveredFile(run), 'yesterday\tblocked\tthe auth fixture\n\n2026-09-11T08:00:00Z\tconflict\tsrc/cli/state.ts\r\n');
    expect(readUndelivered(run)).toEqual([
      { at: 'yesterday', state: 'blocked', note: 'the auth fixture' },
      { at: '2026-09-11T08:00:00Z', state: 'conflict', note: 'src/cli/state.ts' },
    ]);
  });

  it('reads a line in the old epoch format as if it were written in the new one', () => {
    const run = mkTempDir();
    writeFileSync(undeliveredFile(run), '1757577600 blocked the auth  fixture\n1757577660 done\n2026-09-11T08:02:00Z\tconflict\tnew\n');
    expect(readUndelivered(run)).toEqual([
      { at: '2025-09-11T08:00:00Z', state: 'blocked', note: 'the auth  fixture' },
      { at: '2025-09-11T08:01:00Z', state: 'done', note: '' },
      { at: '2026-09-11T08:02:00Z', state: 'conflict', note: 'new' },
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
