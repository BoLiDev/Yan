import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { Task } from '../../src/records/task/index.js';
import { writeDraft } from '../../src/cli/draft.js';

/**
 * `yan draft`: `user`'s notes about a task, in `drafts/`.
 *
 * The reading commands are driven through `bin/yan.mjs`. Writing one needs a
 * terminal, which `runYan` never has, so through `bin/yan.mjs` the refusal is what
 * is under test; the editor round trip runs in process with the terminal check
 * answered, and a fake `$DRAFT_EDITOR` standing in for nvim.
 */

afterAll(cleanupTempDirs);

let home = '';
let drafts = '';
const previousEditor = process.env.DRAFT_EDITOR;

function yan(args: readonly string[], env: Record<string, string> = {}) {
  return runYan(home, args, env);
}

function draft(id: string, body: string, day: number): void {
  mkdirSync(drafts, { recursive: true });
  const file = join(drafts, `${id}.md`);
  writeFileSync(file, body);
  const t = new Date(2026, 8, day, 9, 30, 0).getTime() / 1000;
  utimesSync(file, t, t);
}

/** A `$DRAFT_EDITOR` running this shell body with the file as `$1`. */
function editor(body: string): string {
  const script = join(home, `editor-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(script, `#!/usr/bin/env bash\n${body}\n`);
  return `bash ${script}`;
}

beforeEach(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  Task.create('unify the auth header');
  Task.create('a task with no drafts');
  drafts = join(home, 'tasks', 't001', 'drafts');
});

afterEach(() => {
  if (previousEditor === undefined) delete process.env.DRAFT_EDITOR;
  else process.env.DRAFT_EDITOR = previousEditor;
  vi.restoreAllMocks();
});

describe('writing a draft is user at a keyboard', () => {
  it('refuses without a terminal, naming what reads them', async () => {
    const r = await yan(['draft', 't001']);
    expect(r.code, r.out).toBe(2);
    expect(r.stderr).toContain('needs a terminal');
    expect(r.stderr).toContain("user's own notes");
    expect(existsSync(drafts)).toBe(false);
  });
});

describe('the editor round trip', () => {
  it('keeps a draft something was written into, titled from --title', () => {
    process.env.DRAFT_EDITOR = editor('printf "the parser should own the header\\n" >> "$1"');
    const said = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const path = writeDraft('t001', ['Parser', 'ideas'], { tty: () => true });

    expect(path).toMatch(/\/t001\/drafts\/\d{4}-\d{2}-\d{2}_\d{6}-parser-ideas\.md$/);
    expect(readFileSync(path ?? '', 'utf8')).toBe('# Parser ideas\n\n\nthe parser should own the header\n');
    expect(said.mock.calls.map((c) => String(c[0])).join('')).toContain(`saved ${path}`);
  });

  it('discards a titled draft left as it was', () => {
    process.env.DRAFT_EDITOR = editor('true');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(writeDraft('t001', ['nothing', 'yet'], { tty: () => true })).toBeUndefined();
    expect(readdirSync(drafts)).toEqual([]);
  });

  it('discards an untitled draft the editor never wrote', () => {
    process.env.DRAFT_EDITOR = editor('true');
    const said = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(writeDraft('t001', [], { tty: () => true })).toBeUndefined();
    expect(readdirSync(drafts)).toEqual([]);
    expect(said.mock.calls.map((c) => String(c[0])).join('')).toContain('no draft was kept');
  });

  it('names an editor that is not there', () => {
    process.env.DRAFT_EDITOR = 'no-such-editor-anywhere';
    expect(() => writeDraft('t001', [], { tty: () => true })).toThrow(/not on PATH/);
  });
});

describe('reading drafts works anywhere', () => {
  beforeEach(() => {
    draft('2026-09-14_093000', '# Old idea\n\nparse the header once\n', 14);
    draft('2026-09-16_051516-q4', '# Q4 plan\n\nwe talked about the Q4 Plan at length\n', 16);
  });

  it('ls lists newest first without a terminal, as it does with --plain', async () => {
    const r = await yan(['draft', 'ls', 't001']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe(
      '2026-09-16_051516-q4\t2026-09-16 09:30\tQ4 plan\n2026-09-14_093000\t2026-09-14 09:30\tOld idea\n',
    );
    expect((await yan(['draft', 'ls', '--plain', 't001'])).stdout).toBe(r.stdout);
  });

  it('ls takes the task from $YAN_TASK', async () => {
    const r = await yan(['draft', 'ls', '--limit', '1'], { YAN_TASK: 't001' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe('2026-09-16_051516-q4\t2026-09-16 09:30\tQ4 plan\n');
  });

  it('ls --json carries the preview', async () => {
    const r = await yan(['draft', 'ls', '--json', 't001']);
    expect(r.code, r.out).toBe(0);
    const rows = JSON.parse(r.stdout) as { id: string; title: string; preview: string; updated: string }[];
    expect(rows.map((d) => d.id)).toEqual(['2026-09-16_051516-q4', '2026-09-14_093000']);
    expect(rows[1]?.preview).toBe('parse the header once');
  });

  it('ls prints nothing for a task with no drafts, and creates nothing', async () => {
    const r = await yan(['draft', 'ls', '--plain', 't002']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(join(home, 'tasks', 't002', 'drafts'))).toBe(false);
  });

  it('ls refuses a bad --limit or --since', async () => {
    expectUsage(await yan(['draft', 'ls', '--limit', '0', 't001']), '--limit needs a positive whole number');
    expectUsage(await yan(['draft', 'ls', '--since', 'someday', 't001']), '--since needs a date');
  });

  it('cat prints one, with the task last or from $YAN_TASK', async () => {
    const named = await yan(['draft', 'cat', '2026-09-14_093000', 't001']);
    expect(named.code, named.out).toBe(0);
    expect(named.stdout).toBe('# Old idea\n\nparse the header once\n');
    const inSession = await yan(['draft', 'cat', '2026-09-14_093000'], { YAN_TASK: 't001' });
    expect(inSession.stdout).toBe(named.stdout);
  });

  it('cat refuses a draft that is not there, or an id that leaves the folder', async () => {
    const missing = await yan(['draft', 'cat', '2026-01-01_000000', 't001']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('yan draft ls --plain t001');
    expect((await yan(['draft', 'cat', '../../task', 't001'])).code).toBe(1);
  });

  it('search finds a phrase, and takes a last word naming a task as the task', async () => {
    const r = await yan(['draft', 'search', 'q4', 'plan', 't001']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('2026-09-16_051516-q4\t2026-09-16 09:30\tQ4 plan');
    expect(r.stdout).toContain('Q4 Plan at length');
    expect(r.stdout).not.toContain('Old idea');
  });

  it('search keeps a last word that is not a task in the phrase', async () => {
    const r = await yan(['draft', 'search', 'header', 'once'], { YAN_TASK: 't001' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('2026-09-14_093000');
    const json = await yan(['draft', 'search', 'nothing', 'like', 'this', '--json'], { YAN_TASK: 't001' });
    expect(JSON.parse(json.stdout)).toEqual([]);
  });

  it('dir prints the folder', async () => {
    const r = await yan(['draft', 'dir', 't001']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout.trim()).toBe(`${new Task('t001').dir}/drafts`);
  });
});

describe('which task', () => {
  it('refuses a task that does not exist', async () => {
    const r = await yan(['draft', 'ls', '--plain', 'nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no such task: nope');
  });

  it('asks for the argument when there is neither one nor a terminal', async () => {
    const r = await yan(['draft', 'ls']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('yan draft ls <task-id>');
  });
});
