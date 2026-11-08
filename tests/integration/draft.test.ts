import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { Task } from '../../src/records/task/index.js';
import { writeDraft } from '../../src/cli/draft.js';

/**
 * `yan draft`: `user`'s own notes, the vault's, in `drafts/`.
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

/** A draft written on `day`, as its file's time says; what is listed of it goes by its id, which a checkout does not move. */
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
  drafts = join(home, 'drafts');
});

afterEach(() => {
  if (previousEditor === undefined) delete process.env.DRAFT_EDITOR;
  else process.env.DRAFT_EDITOR = previousEditor;
  vi.restoreAllMocks();
});

describe('writing a draft is user at a keyboard', () => {
  it('refuses without a terminal, naming what reads them', async () => {
    const r = await yan(['draft']);
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
    const path = writeDraft(['Parser', 'ideas'], { tty: () => true });

    expect(path).toMatch(/\/drafts\/\d{4}-\d{2}-\d{2}_\d{6}-parser-ideas\.md$/);
    expect(path?.startsWith(`${home.replace(/\\/g, '/')}/drafts/`)).toBe(true);
    expect(readFileSync(path ?? '', 'utf8')).toBe('# Parser ideas\n\n\nthe parser should own the header\n');
    expect(said.mock.calls.map((c) => String(c[0])).join('')).toContain(`saved ${path}`);
  });

  it('commits and pushes a draft kept, so the page and the agents on other machines have it', async () => {
    const remote = await mkBareRemote(join(mkTempDir(), 'vault.git'));
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'yan tests'], ['config', 'user.email', 'yan-tests@localhost'], ['remote', 'add', 'origin', remote], ['fetch', '-q', 'origin'], ['reset', '-q', 'origin/main']]) {
      await fxGit(args, home);
    }
    process.env.DRAFT_EDITOR = editor('printf "ask about retries\\n" >> "$1"');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const path = writeDraft([], { tty: () => true }) ?? '';

    const pushed = await fxGit(['log', '-1', '--format=%s', '--name-only', 'main'], remote);
    expect(pushed.stdout).toContain(`draft ${basename(path, '.md')} written`);
    expect(pushed.stdout).toContain(`drafts/${basename(path)}`);
  });

  it('discards a titled draft left as it was', () => {
    process.env.DRAFT_EDITOR = editor('true');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(writeDraft(['nothing', 'yet'], { tty: () => true })).toBeUndefined();
    expect(readdirSync(drafts)).toEqual([]);
  });

  it('discards an untitled draft the editor never wrote', () => {
    process.env.DRAFT_EDITOR = editor('true');
    const said = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(writeDraft([], { tty: () => true })).toBeUndefined();
    expect(readdirSync(drafts)).toEqual([]);
    expect(said.mock.calls.map((c) => String(c[0])).join('')).toContain('no draft was kept');
  });

  it('names an editor that is not there', () => {
    process.env.DRAFT_EDITOR = 'no-such-editor-anywhere';
    expect(() => writeDraft([], { tty: () => true })).toThrow(/not on PATH/);
  });
});

describe('reading drafts works anywhere, in any task or none', () => {
  beforeEach(() => {
    draft('2026-09-14_093000', '# Old idea\n\nparse the header once\n', 14);
    draft('2026-09-16_051516-q4', '# Q4 plan\n\nwe talked about the Q4 Plan at length\n', 16);
  });

  it('ls lists newest first without a terminal, as it does with --plain, whichever task is in $YAN_TASK', async () => {
    const r = await yan(['draft', 'ls']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe(
      '2026-09-16_051516-q4\t2026-09-16 05:15\tQ4 plan\n2026-09-14_093000\t2026-09-14 09:30\tOld idea\n',
    );
    expect((await yan(['draft', 'ls', '--plain'])).stdout).toBe(r.stdout);
    expect((await yan(['draft', 'ls'], { YAN_TASK: 't002' })).stdout).toBe(r.stdout);
  });

  it("lists too the drafts once kept in a task's own folder", async () => {
    const old = join(home, 'tasks', 't002', 'drafts');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, '2026-08-01_080000.md'), '# Kept with t002\n');
    utimesSync(join(old, '2026-08-01_080000.md'), new Date(2026, 7, 1), new Date(2026, 7, 1));
    const r = await yan(['draft', 'ls', '--json']);
    expect((JSON.parse(r.stdout) as { id: string; task?: string }[]).map((d) => [d.id, d.task])).toEqual([
      ['2026-09-16_051516-q4', undefined], ['2026-09-14_093000', undefined], ['2026-08-01_080000', 't002'],
    ]);
    expect((await yan(['draft', 'cat', '2026-08-01_080000'])).stdout).toBe('# Kept with t002\n');
  });

  it('ls --limit takes the newest', async () => {
    const r = await yan(['draft', 'ls', '--limit', '1']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe('2026-09-16_051516-q4\t2026-09-16 05:15\tQ4 plan\n');
  });

  it('ls --json carries the preview', async () => {
    const r = await yan(['draft', 'ls', '--json']);
    expect(r.code, r.out).toBe(0);
    const rows = JSON.parse(r.stdout) as { id: string; title: string; preview: string; updated: string }[];
    expect(rows.map((d) => d.id)).toEqual(['2026-09-16_051516-q4', '2026-09-14_093000']);
    expect(rows[1]?.preview).toBe('parse the header once');
  });

  it('ls refuses a bad --limit or --since', async () => {
    expectUsage(await yan(['draft', 'ls', '--limit', '0']), '--limit needs a positive whole number');
    expectUsage(await yan(['draft', 'ls', '--since', 'someday']), '--since needs a date');
  });

  it('cat prints one', async () => {
    const r = await yan(['draft', 'cat', '2026-09-14_093000'], { YAN_TASK: 't002' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe('# Old idea\n\nparse the header once\n');
  });

  it('cat names its pictures by where they are on this machine, for an agent to open', async () => {
    draft('2026-09-17_080000', '# Shot\n\n![the bug](2026-09-17_080000/1.png)\n', 17);
    const r = await yan(['draft', 'cat', '2026-09-17_080000']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe(`# Shot\n\n![the bug](${home.replace(/\\/g, '/')}/drafts/2026-09-17_080000/1.png)\n`);
  });

  it('cat refuses a draft that is not there, or an id that leaves the folder', async () => {
    const missing = await yan(['draft', 'cat', '2026-01-01_000000']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('yan draft ls --plain');
    expect((await yan(['draft', 'cat', '../tasks/t001/task'])).code).toBe(1);
  });

  it('search finds a phrase, every word of it', async () => {
    const r = await yan(['draft', 'search', 'q4', 'plan']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('2026-09-16_051516-q4\t2026-09-16 05:15\tQ4 plan');
    expect(r.stdout).toContain('Q4 Plan at length');
    expect(r.stdout).not.toContain('Old idea');
    const json = await yan(['draft', 'search', 'nothing', 'like', 'this', '--json']);
    expect(JSON.parse(json.stdout)).toEqual([]);
  });

  it('dir prints the folder', async () => {
    const r = await yan(['draft', 'dir']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout.trim()).toBe(`${home.replace(/\\/g, '/')}/drafts`);
  });

  it('yan context lists the newest for the agent, with how to read one', async () => {
    const r = await yan(['context'], { YAN_TASK: 't002' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain("drafts  the user's own notes, shared by every task");
    expect(r.stdout).toMatch(/2026-09-16_051516-q4 +2026-09-16 05:15 +Q4 plan\n +2026-09-14_093000 +2026-09-14 09:30 +Old idea/);
    const json = JSON.parse((await yan(['context', '--json'], { YAN_TASK: 't002' })).stdout) as { drafts: { id: string }[] };
    expect(json.drafts.map((d) => d.id)).toEqual(['2026-09-16_051516-q4', '2026-09-14_093000']);
  });
});
