import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { Task } from '../task/index.js';
import { Drafts, discardIfUntouched, isValidId, newDraftId, slugify, titleTemplate } from './index.js';

/**
 * The store keeps cli-kit's `draft` format, so what its own suite guarantees
 * is guaranteed here too, per task rather than per machine.
 */

let home = '';
let previousHome: string | undefined;
let drafts: Drafts;

function write(id: string, body: string, ageSeconds: number): string {
  mkdirSync(drafts.dir, { recursive: true });
  const p = drafts.pathFor(id);
  writeFileSync(p, body, 'utf8');
  const t = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
  Task.create('t042', 'unify the auth header');
  drafts = new Drafts('t042');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

afterAll(cleanupTempDirs);

describe('where drafts live', () => {
  it('is artifacts/drafts/ under the task', () => {
    expect(drafts.dir).toBe(`${new Task('t042').dir}/artifacts/drafts`);
  });

  it('reads an absent folder as empty, and does not create it', () => {
    expect(drafts.list()).toEqual([]);
    expect(drafts.count()).toBe(0);
    expect(drafts.search('anything')).toEqual([]);
    expect(drafts.get('2026-09-16_051516')).toBeUndefined();
    expect(existsSync(drafts.dir)).toBe(false);
  });

  it('creates the folder only when asked to', () => {
    drafts.ensureDir();
    expect(readdirSync(drafts.dir)).toEqual([]);
  });
});

describe('ids', () => {
  it('are a local timestamp plus a slug of the title', () => {
    const now = new Date(2026, 8, 12, 2, 12, 12);
    expect(newDraftId([], now)).toBe('2026-09-12_021212');
    expect(newDraftId(['Meeting notes:', 'Q4 plan'], now)).toBe('2026-09-12_021212-meeting-notes-q4-plan');
    expect(slugify(['  --weird__chars!! '])).toBe('weird-chars');
    expect(titleTemplate(['a', 'b'])).toBe('# a b\n\n\n');
    expect(titleTemplate([])).toBe('');
  });

  it('refuse anything that could leave the folder', () => {
    write('ok', 'fine', 0);
    expect(drafts.get('ok')?.body).toBe('fine');
    for (const bad of ['../ok', '..\\ok', '/etc/passwd', '.hidden', '']) {
      expect(isValidId(bad), bad).toBe(false);
      expect(drafts.get(bad), bad).toBeUndefined();
    }
    expect(drafts.get('missing')).toBeUndefined();
  });
});

describe('listing', () => {
  it('is newest first, with a title and a preview', () => {
    write('old', '# Old note\n\nbody of old\n', 300);
    write('new', 'New note without heading\nsecond   line\nthird\n', 10);
    writeFileSync(join(drafts.dir, 'ignored.txt'), 'not markdown', 'utf8');
    const rows = drafts.list();
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
    expect(rows[0]?.title).toBe('New note without heading');
    expect(rows[0]?.preview).toBe('second line third');
    expect(rows[1]?.title).toBe('Old note');
    expect(rows[1]?.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(drafts.count()).toBe(2);
  });

  it('honours limit and since', () => {
    write('a', 'a', 1000);
    write('b', 'b', 100);
    write('c', 'c', 1);
    expect(drafts.list({ limit: 2 }).map((r) => r.id)).toEqual(['c', 'b']);
    const since = new Date(Date.now() - 500 * 1000);
    expect(drafts.list({ since }).map((r) => r.id)).toEqual(['c', 'b']);
  });

  it('calls a blank draft (empty)', () => {
    write('blank', '\n\n', 0);
    expect(drafts.list()[0]?.title).toBe('(empty)');
  });
});

describe('search', () => {
  it('is case-insensitive, newest first, with a snippet', () => {
    write('x', '# Plans\n\nWe talked about the Q4 Plan at length today.\n', 5);
    write('y', '# Other\n\nnothing here\n', 1);
    const hits = drafts.search('q4 plan');
    expect(hits.map((h) => h.id)).toEqual(['x']);
    expect(hits[0]?.snippet).toMatch(/Q4 Plan/);
    expect(drafts.search('zzz')).toEqual([]);
    expect(drafts.search('')).toEqual([]);
  });

  it('stops at the limit', () => {
    write('p', 'plan one', 3);
    write('q', 'plan two', 2);
    write('r', 'plan three', 1);
    expect(drafts.search('plan', 2).map((h) => h.id)).toEqual(['r', 'q']);
  });
});

describe('discarding', () => {
  it('drops a blank or untouched draft, and keeps one with something in it', () => {
    const p = write('t', '# Title\n\n\n', 0);
    expect(discardIfUntouched(p, '# Title\n\n\n')).toBe(true);
    expect(drafts.get('t')).toBeUndefined();
    const q = write('u', '# Title\n\nreal content\n', 0);
    expect(discardIfUntouched(q, '# Title\n\n\n')).toBe(false);
    expect(drafts.get('u')).toBeDefined();
    expect(discardIfUntouched(drafts.pathFor('never-existed'), '')).toBe(true);
  });
});
