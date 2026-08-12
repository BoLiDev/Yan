import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  cleanupTempDirs,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../helpers/fixtures.js';
import { rebuild, type Sources } from '../../src/cli/session-start.js';
import { Task } from '../../src/records/task/index.js';
import type { Alive } from '../../src/externals/herdr/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';
import type { LeaseRow } from '../../src/externals/worktree/index.js';

/**
 * `yan session-start`, ported from `tests/unit/yan-session-start.test.sh`.
 *
 * Phase 7 Trace: "session-start rebuilds from disk + Herdr + pool + forge with
 * no durable `yan` state."
 *
 * The second half is the one worth a test. agents.md §5.1 says yan holds no
 * persistent running state, and that is the whole reason a restart is a
 * non-event; the moment this command writes a cache, a session file or a
 * "last seen" timestamp, that stops being true and something exists that can
 * disagree with the world. So the assertion is blunt: `$YAN_HOME` is
 * byte-for-byte identical before and after, several times over.
 *
 * The first half is checked by taking every source away one at a time. A fresh
 * machine has no Herdr server, the pool root may be on a disk that is not
 * mounted, and the host is unreachable on a train — all three have to come back
 * as `unknown`, and none of them may end the command.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let run = '';
let previousHome: string | undefined;

const MR = 'https://forge.invalid/acme/widget/-/merge_requests/31';
const TREE = 'C:/pool/monorepo-x/1';
const LEASE = 'lease-abc';

const asked = { panes: [] as string[], clones: [] as string[], mrs: [] as string[] };

function sources(overrides: Partial<Sources> = {}): Sources {
  return {
    aliveOf: (pane): Alive => {
      asked.panes.push(pane);
      return 'alive';
    },
    leasesOf: (c): LeaseRow[] => {
      asked.clones.push(c);
      return [{ slot: 1, path: TREE, branch: 'yan/t042-auth-s2', base: 'feat/auth', holder: 't042/auth/s2', lease_id: LEASE, at: 0 }];
    },
    mrStateOf: (ref): MrState => {
      asked.mrs.push(ref.mr);
      return 'open';
    },
    ...overrides,
  };
}

/** Every file under $YAN_HOME, with its size. */
function snapshot(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else files.push(`${relative(home, full).replace(/\\/g, '/')} ${st.size}`);
    }
  };
  walk(home);
  return files.sort().join('\n');
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir(), { withDist: true });
  process.env.YAN_HOME = home;
  clone = join(home, 'repos', 'monorepo-x');
  mkdirSync(clone, { recursive: true });
  // A clone is where the registry says it is now, not where a convention put
  // it (v3 td repos.md §2). The path does not change; only the reason yan
  // can find it.
  registerRepo(home, 'monorepo-x', clone);

  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'master', { branch: 'feat/auth', scope: ['apps/auth'] });
  Task.create('t099', 'a task nobody has started');
  new Task('t099').addUnit('api', 'monorepo-x', 'master', { branch: 'feat/api' });

  run = join(home, 'tasks', 't042', 'shifts', 's2', 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(
    join(run, 'meta.json'),
    `${JSON.stringify({
      version: 1, task: 't042', sid: 's2', unit: 'auth', repo: 'monorepo-x',
      branch: 'yan/t042-auth-s2', base: 'feat/auth', tree: TREE, clone,
      holder: 't042/auth/s2', lease_id: LEASE, agent: 'claude',
      container: 'w1', pane: 'w1:p7', mr: MR,
    })}\n`,
  );
  writeFileSync(join(run, 'status'), '2026-08-09T09:00:00Z\tstarted\tread the brief\n');

  // s1 has already clocked out: its run/ is gone and only the long-lived files
  // remain. Nothing live should be asked about it.
  mkdirSync(join(home, 'tasks', 't042', 'shifts', 's1'), { recursive: true });
  writeFileSync(join(home, 'tasks', 't042', 'shifts', 's1', 'outcome.md'), '# s1\n');

  asked.panes = [];
  asked.clones = [];
  asked.mrs = [];
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('the rebuild', () => {
  it('asks all four sources, in yan vocabulary', () => {
    const picture = rebuild(['t042'], sources());
    const s2 = picture.tasks[0].shifts.find((s) => s.sid === 's2');

    expect(s2?.terminal, 'the terminal was asked').toBe('alive');
    expect(s2?.pool, 'the pool was asked').toBe('leased');
    expect(s2?.mr_state, 'the host was asked').toBe('open');

    expect(asked.panes, 'the terminal is asked by id, never by label').toEqual(['w1:p7']);
    expect(asked.clones).toEqual([clone]);
    expect(asked.mrs).toEqual([MR]);
  });

  it('reports a clocked-out shift, and asks nothing live about it', () => {
    const s1 = rebuild(['t042'], sources()).tasks[0].shifts.find((s) => s.sid === 's1');
    expect(s1?.live).toBe(false);
    expect(s1?.terminal).toBe('n/a');
    expect(s1?.pool).toBe('n/a');
    expect(s1?.mr_state).toBe('n/a');
  });

  it('asks the pool once per clone, and remembers nothing beyond the call', () => {
    rebuild(['t042'], sources());
    expect(asked.clones).toHaveLength(1);
  });
});

describe('it writes nothing, anywhere', () => {
  it('leaves $YAN_HOME byte-for-byte identical, on every path', async () => {
    const before = snapshot();

    expect((await runYan(home, ['session-start', '--task', 't042'])).code).toBe(0);
    expect(snapshot(), 'session-start must not create or change a single file').toBe(before);

    expect((await runYan(home, ['session-start', '--task', 't042', '--json'])).code).toBe(0);
    expect(snapshot(), 'nor on the --json path').toBe(before);

    expect((await runYan(home, ['session-start', '--all'])).code).toBe(0);
    expect(snapshot()).toBe(before);
  });
});

describe('through bin/yan', () => {
  it('renders the task, its unit and its shifts', async () => {
    const r = await runYan(home, ['session-start', '--task', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('t042  unify the auth header');
    expect(r.stdout).toContain('unit auth');
    expect(r.stdout).toContain('branch feat/auth');
    expect(r.stdout).toContain('shift s2');
    expect(r.stdout, 's1 is reported, and reported as finished').toContain('clocked out');
  });

  it('reports every task when no id is given', async () => {
    const r = await runYan(home, ['session-start', '--all']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('t042');
    expect(r.stdout).toContain('t099');
    expect(
      r.stdout,
      '"no shift has ever been dispatched" is shifts/ being empty, not a stored flag',
    ).toContain('no shift has ever been dispatched');
  });

  it('is machine readable, with the same derivation', async () => {
    const r = await runYan(home, ['session-start', '--task', 't042', '--json']);
    expect(r.code, r.out).toBe(0);
    const picture = JSON.parse(r.stdout) as { tasks: { id: string; shifts: { sid: string; live: boolean }[] }[] };
    expect(picture.tasks[0].id).toBe('t042');
    expect(picture.tasks[0].shifts).toHaveLength(2);
    expect(picture.tasks[0].shifts.find((s) => s.sid === 's1')?.live).toBe(false);
  });

  it('refuses a task that does not exist', async () => {
    const r = await runYan(home, ['session-start', '--task', 'nosuchtask']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('no such task');
  });
});

describe('a source that will not answer costs one fact, never the command', () => {
  const boom = (): never => {
    throw new Error('this source cannot be reached');
  };

  it('reports an unreachable terminal as unknown', () => {
    const s2 = rebuild(['t042'], sources({ aliveOf: boom })).tasks[0].shifts.find((s) => s.sid === 's2');
    expect(s2?.terminal).toBe('unknown');
  });

  it('reports an unreachable pool as unknown', () => {
    const s2 = rebuild(['t042'], sources({ leasesOf: boom })).tasks[0].shifts.find((s) => s.sid === 's2');
    expect(s2?.pool).toBe('unknown');
  });

  it('reports an unreachable host as unknown', () => {
    const s2 = rebuild(['t042'], sources({ mrStateOf: boom })).tasks[0].shifts.find((s) => s.sid === 's2');
    expect(s2?.mr_state).toBe('unknown');
  });

  it('survives all three at once, which is what being offline looks like', () => {
    const picture = rebuild(['t042'], { aliveOf: boom, leasesOf: boom, mrStateOf: boom });
    const s2 = picture.tasks[0].shifts.find((s) => s.sid === 's2');
    expect(s2?.terminal).toBe('unknown');
    expect(s2?.pool).toBe('unknown');
    expect(s2?.mr_state).toBe('unknown');
  });
});

describe('a half-written meta.json is one lost fact, never a crash', () => {
  it('survives a file that is not JSON', async () => {
    writeFileSync(join(run, 'meta.json'), 'not json at all\n');
    const r = await runYan(home, ['session-start', '--task', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('shift s2');
  });

  it('survives a missing file', async () => {
    rmSync(join(run, 'meta.json'));
    expect((await runYan(home, ['session-start', '--task', 't042'])).code).toBe(0);
  });
});

/**
 * Skills: standing instructions in prose (v3 td vault.md).
 *
 * The mechanism is deliberately the whole of it — session-start is the
 * SessionStart hook, so what it prints is what the session starts knowing.
 * There is nothing to run and nothing to register, which is why these tests
 * are about READING: which files, in which order, and what happens when there
 * are none.
 */
describe('skills reach the session', () => {
  const vaultSkills = () => join(home, 'skills');
  const machineSkills = () => join(home, '.machine', 'skills');

  beforeEach(() => {
    rmSync(vaultSkills(), { recursive: true, force: true });
    rmSync(machineSkills(), { recursive: true, force: true });
  });

  it('says nothing at all when there are none', async () => {
    const r = await runYan(home, ['session-start']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain('what you may do yourself here');
  });

  it('prints them verbatim, and names where each came from', async () => {
    mkdirSync(vaultSkills(), { recursive: true });
    writeFileSync(join(vaultSkills(), 'build.md'), '# Checking the build\n\nYou may run npm test yourself.\n');

    const r = await runYan(home, ['session-start']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('what you may do yourself here');
    expect(r.stdout).toContain('## skills/build.md');
    expect(r.stdout, 'verbatim: it is user speaking, not yan paraphrasing').toContain('You may run npm test yourself.');
  });

  it('takes the vault first and the machine after, each labelled', async () => {
    mkdirSync(vaultSkills(), { recursive: true });
    mkdirSync(machineSkills(), { recursive: true });
    writeFileSync(join(vaultSkills(), 'a-context.md'), 'the context rule\n');
    writeFileSync(join(machineSkills(), 'b-box.md'), 'the rule for this box\n');

    const r = await runYan(home, ['session-start']);
    const context = r.stdout.indexOf('skills/a-context.md');
    const box = r.stdout.indexOf('machine skills/b-box.md');
    expect(context).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(-1);
    expect(context, 'what yan may do is normally a property of the context').toBeLessThan(box);
  });

  it('ignores anything that is not a .md, and anything empty', async () => {
    mkdirSync(vaultSkills(), { recursive: true });
    writeFileSync(join(vaultSkills(), 'notes.txt'), 'not a skill\n');
    writeFileSync(join(vaultSkills(), 'blank.md'), '   \n');

    const r = await runYan(home, ['session-start']);
    expect(r.stdout).not.toContain('not a skill');
    expect(r.stdout).not.toContain('blank.md');
  });

  it('still writes nothing to the vault: a session start is a read', async () => {
    mkdirSync(vaultSkills(), { recursive: true });
    writeFileSync(join(vaultSkills(), 'one.md'), 'a rule\n');
    const before = readdirSync(home).sort().join(',');
    await runYan(home, ['session-start']);
    expect(readdirSync(home).sort().join(',')).toBe(before);
  });
});
