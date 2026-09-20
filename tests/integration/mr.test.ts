import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkClone,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../helpers/fixtures.js';
import { openMr, type MrOptions } from '../../src/cli/mr.js';
import { Deliverables, Task } from '../../src/records/task/index.js';
import type { MrCreateOptions } from '../../src/externals/remote-git/index.js';

/**
 * `yan mr`.
 *
 * The host is a recording stand-in, so nothing here reaches the network. git
 * is real, because the one git question this command may ask — is the branch
 * on the remote yet — matters as much as the MR: it must never push.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let bare = '';
let previousHome: string | undefined;

const URL_88 = 'https://forge.invalid/acme/monorepo-x/-/merge_requests/88';

let created: MrCreateOptions[] = [];
let refuse: Error | undefined;
const createMr = (options: MrCreateOptions): string => {
  created.push(options);
  if (refuse !== undefined) throw refuse;
  return URL_88;
};

function open(options: MrOptions): { code: number; message: string } {
  try {
    openMr(options, createMr);
    return { code: 0, message: '' };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '' };
  }
}

function unitMr(task: string, unit: string): unknown {
  const doc = JSON.parse(readFileSync(join(home, 'tasks', task, 'task.json'), 'utf8')) as {
    units: Record<string, unknown>[];
  };
  return doc.units.find((u) => u.name === unit)?.mr;
}

beforeEach(async () => {
  previousHome = process.env.YAN_HOME;
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  process.env.YAN_HOME = home;

  bare = await mkBareRemote(join(tmp, 'remote.git'));
  clone = await mkClone(bare, join(home, 'repos', 'monorepo-x'));
  registerRepo(home, 'monorepo-x', clone, { url: bare });
  // Only feat/auth is published; feat/later deliberately is not.
  await fxGit(['-C', clone, 'push', 'origin', 'main:feat/auth']);
  await fxGit(['-C', clone, 'push', 'origin', 'main:master']);

  Task.create('t042', 'unify the auth header');
  const t = new Task('t042');
  t.addUnit('auth', 'monorepo-x', 'master', { branch: 'feat/auth', scope: ['apps/auth'] });
  t.addUnit('proto', 'monorepo-x', 'master', { branch: 'feat/proto' });

  Task.create('t043', 'not pushed yet');
  new Task('t043').addUnit('auth', 'monorepo-x', 'master', { branch: 'feat/later' });

  created = [];
  refuse = undefined;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('it opens the MR and records the URL', () => {
  it('runs integration branch → target and writes unit.mr', () => {
    const r = open({ task: 't042', unit: 'auth' });
    expect(r.code, r.message).toBe(0);

    expect(created).toHaveLength(1);
    expect(created[0].source, 'the outbound MR runs integration branch -> target').toBe('feat/auth');
    expect(created[0].target).toBe('master');
    expect(created[0].draft).toBeUndefined();

    expect(unitMr('t042', 'auth'), 'unit.mr is written when yan mr opens it').toBe(URL_88);
    expect(readFileSync(join(home, 'tasks', 't042', 'log.md'), 'utf8')).toContain('outbound MR opened');
  });

  it("defaults the title to the task's, qualified by the unit when there are several", () => {
    open({ task: 't042', unit: 'auth' });
    expect(created[0].title).toBe('unify the auth header (auth)');
  });

  it("defaults the body to the task's brief.md while it has no deliverables", () => {
    open({ task: 't042', unit: 'auth' });
    expect(created[0].bodyFile).toBe(join(new Task('t042').dir, 'brief.md'));
    expect(created[0].body).toBeUndefined();
  });

  it('writes a URL ref in the short form, as the terminal does', () => {
    const record = new Deliverables('t042');
    record.add(['yan ls is an overview.']);
    record.done('d1', '2026-09-18', ['https://github.com/acme/site/pull/52', 'PR #53']);

    open({ task: 't042', unit: 'auth' });
    expect(created[0].body).toContain('- [x] yan ls is an overview. \u2014 2026-09-18 \u00b7 PR #52 \u00b7 PR #53');
  });

  it('follows the brief with the deliverables as a list once there are any', () => {
    const record = new Deliverables('t042');
    record.add(['yan ls is an overview.', 'The report shows a brief.', 'A per-task status word.']);
    record.done('d1', '2026-09-18', ['PR #52', 'PR #53']);
    record.abandon('d3', 'user reads that off the header');

    open({ task: 't042', unit: 'auth' });
    expect(created[0].bodyFile, 'one body, not a file and a body').toBeUndefined();
    expect(created[0].body).toBe(
      [
        '# t042 unify the auth header',
        '',
        '## Deliverables',
        '',
        '- [x] yan ls is an overview. — 2026-09-18 · PR #52 · PR #53',
        '- [ ] The report shows a brief.',
        '- [-] A per-task status word. — abandoned: user reads that off the header',
        '',
      ].join('\n'),
    );
  });

  it('leaves a body or a body file the caller gave alone', () => {
    new Deliverables('t042').add(['one']);
    open({ task: 't042', unit: 'auth', body: 'mine' });
    expect(created[0].body).toBe('mine');
  });

  it('never pushes: the only git question it asks is whether the branch is on the remote', () => {
    // Structural, because a command that pushed on the way to opening an MR
    // would not fail loudly.
    const source = readFileSync(join(process.cwd(), 'src', 'cli', 'mr.ts'), 'utf8');
    expect(source).not.toContain('push(');
    expect(source).toContain('remoteBranchExists');
  });
});

describe('a round has ONE outbound MR', () => {
  it('refuses a second, and says how a new round is started', () => {
    expect(open({ task: 't042', unit: 'auth' }).code).toBe(0);
    const again = open({ task: 't042', unit: 'auth' });
    expect(again.code).toBe(2);
    expect(again.message).toContain('already has an outbound merge request');
    expect(again.message, 'a new round is how a second one is opened').toContain('unit set --branch');
  });
});

describe('the branch has to be on the remote first', () => {
  it('says so, says how to fix it, and records nothing', () => {
    const r = open({ task: 't043', unit: 'auth' });
    expect(r.code).not.toBe(0);
    expect(r.message).toContain('not on the remote yet');
    expect(r.message).toContain('git push -u origin');
    expect(unitMr('t043', 'auth'), 'and nothing was recorded').toBeNull();
    expect(created).toEqual([]);
  });
});

describe('a host that refuses records nothing', () => {
  it('leaves unit.mr empty', () => {
    refuse = new Error('could not open the merge request');
    const r = open({ task: 't042', unit: 'auth' });
    expect(r.code).not.toBe(0);
    expect(unitMr('t042', 'auth'), 'unit.mr is written only after the host confirmed the URL').toBeNull();
  });
});

describe('usage errors', () => {
  it('names what is missing, and refuses two ways of giving a body', async () => {
    expect((await runYan(home, ['mr'], { YAN_TASK: 't042' })).out).toContain('--unit is required');
    expect((await runYan(home, ['mr', '--unit', 'auth'], { YAN_TASK: 'nosuch' })).out).toContain('no such task');
    expect((await runYan(home, ['mr', '--unit', 'nosuch'], { YAN_TASK: 't042' })).out).toContain('no such unit');

    const both = await runYan(home, ['mr', '--unit', 'auth', '--body', 'a', '--body-file', 'b'], { YAN_TASK: 't042' });
    expect(both.code).toBe(2);
    expect(both.out).toContain('alternatives');
  });
});
