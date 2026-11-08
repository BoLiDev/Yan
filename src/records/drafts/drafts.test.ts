import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { Task } from '../task/index.js';
import { Drafts, discardIfUntouched, newDraftId, titleTemplate } from './index.js';
import { isValidId, picturesFrom, slugify } from './drafts.js';

/**
 * The store keeps cli-kit's `draft` format, so what its own suite guarantees
 * is guaranteed here too, for the vault rather than per machine.
 */

let drafts: Drafts;

function write(id: string, body: string, ageSeconds: number, dir = drafts.dir): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.md`);
  writeFileSync(p, body, 'utf8');
  const t = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(p, t, t);
  return p;
}

let home = '';
beforeEach(() => {
  home = mkYanHome(mkTempDir());
  drafts = new Drafts();
});


afterAll(cleanupTempDirs);

describe('where drafts live', () => {
  it('is drafts/ at the top of the vault', () => {
    expect(drafts.dir).toBe(`${home.replace(/\\/g, '/')}/drafts`);
  });

  it("reads too the ones kept in a task's own folder before, where they are, a draft at the top winning an id both have", () => {
    const old = new Task(Task.create('unify the auth header').id).dir;
    write('2026-09-01_090000', '# Kept with its task\n', 300, join(old, 'drafts'));
    write('same', '# The task\'s\n', 200, join(old, 'drafts'));
    write('same', '# The vault\'s\n', 100);
    expect(drafts.list().map((d) => [d.id, d.title, d.task])).toEqual([['same', "The vault's", undefined], ['2026-09-01_090000', 'Kept with its task', 't001']]);
    expect(drafts.get('2026-09-01_090000')?.body).toBe('# Kept with its task\n');
    expect(drafts.pathOf('2026-09-01_090000')).toBe(`${old}/drafts/2026-09-01_090000.md`);
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

  it('is newest by when each was begun, as its id says, whatever times a checkout gave the files', () => {
    // Pulled on another machine: the older draft's file was written last.
    write('2026-11-08_100000-newer', 'newer', 3000);
    write('2026-10-01_090000-older', 'older', 1);
    expect(drafts.list().map((r) => r.id)).toEqual(['2026-11-08_100000-newer', '2026-10-01_090000-older']);
    expect(drafts.get('2026-10-01_090000-older')?.updated).toBe(new Date(2026, 9, 1, 9, 0, 0).toISOString());
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

describe('writing whole', () => {
  it('names a new draft for its first line, at the top, and writes an old one where it is', () => {
    const id = drafts.write(undefined, '# Parser ideas\n\nown the header');
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}-parser-ideas$/);
    expect(readFileSync(drafts.pathFor(id ?? ''), 'utf8')).toBe('# Parser ideas\n\nown the header\n');
    const old = join(new Task(Task.create('older').id).dir, 'drafts');
    write('kept-before', 'before', 10, old);
    expect(drafts.write('kept-before', 'after\n')).toBe('kept-before');
    expect(readFileSync(join(old, 'kept-before.md'), 'utf8')).toBe('after\n');
    expect(existsSync(drafts.pathFor('kept-before'))).toBe(false);
  });

  it('removes one written blank, and keeps two begun in the same second apart', () => {
    const [a, b] = [drafts.write(undefined, 'same'), drafts.write(undefined, 'same')];
    expect(a).not.toBe(b);
    expect(drafts.count()).toBe(2);
    expect(drafts.write(a, '  \n')).toBeUndefined();
    expect(drafts.list().map((d) => d.id)).toEqual([b]);
    expect(() => drafts.write('never-was', 'x')).toThrow(/no draft never-was/);
  });
});

describe('pictures', () => {
  it('are kept numbered in a folder beside their draft, and go with it', () => {
    const id = drafts.write(undefined, '# With pictures') as string;
    expect(drafts.addPicture(id, Buffer.from('a'), 'png')).toBe(`${id}/1.png`);
    expect(drafts.addPicture(id, Buffer.from('b'), 'jpg')).toBe(`${id}/2.jpg`);
    expect(readdirSync(join(drafts.dir, id)).sort()).toEqual(['1.png', '2.jpg']);
    expect(drafts.list().map((d) => d.id), 'the folder is no draft').toEqual([id]);
    expect(drafts.remove(id)).toBe(true);
    expect(existsSync(join(drafts.dir, id))).toBe(false);
    expect(drafts.remove(id)).toBe(false);
  });

  it('are never written out of the vault through a link, nor is a draft that is one read', () => {
    const outside = mkTempDir('yan-outside-');
    writeFileSync(join(outside, 'secret.md'), '# not a draft\n');
    const id = drafts.write(undefined, '# With a linked folder') as string;
    symlinkSync(outside, join(drafts.dir, id));
    expect(() => drafts.addPicture(id, Buffer.from('a'), 'png')).toThrow(/link/);
    expect(readdirSync(outside)).toEqual(['secret.md']);

    symlinkSync(join(outside, 'secret.md'), join(drafts.dir, '2026-11-08_120000-linked.md'));
    expect(drafts.list().map((d) => d.id)).toEqual([id]);
    expect(drafts.get('2026-11-08_120000-linked')).toBeUndefined();
  });

  it('are named by where they are for a reader outside the vault, and the rest of the Markdown left as it is', () => {
    const body = '# x\n\n![shot](x/1.png) and ![web](https://example.com/a.png) and ![](/abs/b.png) and [a link](x/1.png)\n';
    expect(picturesFrom(body, '/vault/drafts/x.md')).toBe('# x\n\n![shot](/vault/drafts/x/1.png) and ![web](https://example.com/a.png) and ![](/abs/b.png) and [a link](x/1.png)\n');
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
