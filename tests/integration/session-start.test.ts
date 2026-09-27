import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { snapshot, liveShift, seedT042 } from '../helpers/records.js';
import { rebuild, type Sources } from '../../src/cli/session-start/picture.js';
import { Task } from '../../src/records/task/index.js';
import type { Alive } from '../../src/externals/herdr/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';
import type { LeaseRow } from '../../src/externals/worktree/index.js';

/**
 * `yan session-start`.
 *
 * It rebuilds from disk, Herdr, the pool and the host, and writes nothing:
 * `$YAN_HOME` is compared byte for byte before and after, several times over.
 *
 * Each source is taken away in turn — no Herdr server, no pool root, no host —
 * and every one has to come back as `unknown` without ending the command.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let run = '';

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
function listing(): string {
  return snapshot(home, { size: true }).join('\n');
}

beforeEach(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  clone = join(home, 'repos', 'monorepo-x');
  mkdirSync(clone, { recursive: true });
  registerRepo(home, 'monorepo-x', clone);

  seedT042();
  Task.create('t099', 'a task nobody has started');
  new Task('t099').addUnit('api', 'monorepo-x', 'master', { branch: 'feat/api' });

  run = liveShift(home, 't042', 's2', {
    task: 't042', sid: 's2', unit: 'auth', repo: 'monorepo-x',
    branch: 'yan/t042-auth-s2', base: 'feat/auth', tree: TREE, clone,
    holder: 't042/auth/s2', lease_id: LEASE, agent: 'claude',
    container: 'w1', pane: 'w1:p7', mr: MR,
  });
  writeFileSync(join(run, 'status'), '2026-08-09T09:00:00Z\tstarted\tread the brief\n');

  // s1 has already clocked out: its run/ is gone and only the long-lived files
  // remain. Nothing live should be asked about it.
  mkdirSync(join(home, 'tasks', 't042', 'shifts', 's1'), { recursive: true });
  writeFileSync(join(home, 'tasks', 't042', 'shifts', 's1', 'outcome.md'), '# s1\n');

  asked.panes = [];
  asked.clones = [];
  asked.mrs = [];
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
    const before = listing();

    expect((await runYan(home, ['session-start'], { YAN_TASK: 't042' })).code).toBe(0);
    expect(listing(), 'session-start must not create or change a single file').toBe(before);

    expect((await runYan(home, ['session-start', '--json'], { YAN_TASK: 't042' })).code).toBe(0);
    expect(listing(), 'nor on the --json path').toBe(before);

    expect((await runYan(home, ['session-start', '--all'])).code).toBe(0);
    expect(listing()).toBe(before);
  });
});

describe('through bin/yan', () => {
  it('renders the task, its unit and its shifts', async () => {
    const r = await runYan(home, ['session-start'], { YAN_TASK: 't042' });
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
    const r = await runYan(home, ['session-start', '--json'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    const picture = JSON.parse(r.stdout) as { tasks: { id: string; shifts: { sid: string; live: boolean }[] }[] };
    expect(picture.tasks[0].id).toBe('t042');
    expect(picture.tasks[0].shifts).toHaveLength(2);
    expect(picture.tasks[0].shifts.find((s) => s.sid === 's1')?.live).toBe(false);
  });

  it('tells a shift whose picture this is, and prints nothing else', async () => {
    // Registered as the SessionStart hook, so a shift working on the yan
    // repository fires it too; only a shift's environment carries YAN_SID.
    const r = await runYan(home, ['session-start'], { YAN_TASK: 't042', YAN_SID: 's2' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('shift s2 of task t042');
    expect(r.stdout, 'the picture itself is the main agent\'s').not.toContain('unit auth');

    // A caller asking for --json asked on purpose.
    const json = await runYan(home, ['session-start', '--json'], { YAN_TASK: 't042', YAN_SID: 's2' });
    expect(json.code, json.out).toBe(0);
    expect((JSON.parse(json.stdout) as { tasks: { id: string }[] }).tasks[0].id).toBe('t042');
  });

  it('refuses a task that does not exist', async () => {
    const r = await runYan(home, ['session-start'], { YAN_TASK: 'nosuchtask' });
    expectUsage(r, 'no such task');
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
    const r = await runYan(home, ['session-start'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('shift s2');
  });

  it('survives a missing file', async () => {
    rmSync(join(run, 'meta.json'));
    expect((await runYan(home, ['session-start'], { YAN_TASK: 't042' })).code).toBe(0);
  });
});

/**
 * Skills are prose with nothing to run or register, so what is under test is
 * the reading: which files, in which order, and what happens when there are
 * none.
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
    expect(r.stdout).not.toContain('What you may do yourself here');
  });

  it('indexes them by path, name and description from the front matter', async () => {
    mkdirSync(vaultSkills(), { recursive: true });
    writeFileSync(
      join(vaultSkills(), 'build.md'),
      [
        '---',
        'name: Checking the build',
        'description: you may run npm test yourself',
        '---',
        '',
        '# Checking the build',
        '',
        'But do not fix what it finds: a fix is work, and work goes to a shift.',
        '',
      ].join('\n'),
    );

    const r = await runYan(home, ['session-start']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('What you may do yourself here');
    expect(r.stdout).toContain('skills/build.md');
    expect(r.stdout).toContain('Checking the build');
    expect(r.stdout).toContain('you may run npm test yourself');
    // An index, not the text: everything printed here sits in the context for
    // the whole session.
    expect(r.stdout, 'the body is not carried').not.toContain('work goes to a shift');
  });

  it('lists a file with no front matter anyway, under its own name', async () => {
    mkdirSync(vaultSkills(), { recursive: true });
    writeFileSync(join(vaultSkills(), 'undeclared.md'), '# No front matter here\n\njust prose\n');

    const r = await runYan(home, ['session-start']);
    // A skill nobody described is not one yan should pretend it cannot see.
    expect(r.stdout).toContain('skills/undeclared.md');
    expect(r.stdout, 'the file name stands in for a name it never declared').toContain('undeclared.md');
    expect(r.stdout).not.toContain('just prose');
  });

  it('takes a quoted value, and ignores keys it does not know', async () => {
    mkdirSync(vaultSkills(), { recursive: true });
    writeFileSync(
      join(vaultSkills(), 'quoted.md'),
      ['---', 'name: "Release rules"', "description: 'cut from release/*, not master'", 'colour: blue', '---', '', 'body', ''].join('\n'),
    );

    const r = await runYan(home, ['session-start']);
    expect(r.stdout).toContain('Release rules');
    expect(r.stdout).toContain('cut from release/*, not master');
    expect(r.stdout).not.toContain('blue');
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

/**
 * What a task remembers reaches the session for that task, and only for it:
 * an unscoped session start is a queue, not a briefing.
 */
describe('the task memory reaches the session', () => {
  function logLines(lines: string[]): void {
    writeFileSync(join(home, 'tasks', 't042', 'log.md'), `# t042 unify the auth header\n\n${lines.join('\n')}\n`);
  }

  it('prints the brief, the log excerpt, the learnings index and user.md for one task', async () => {
    writeFileSync(join(home, 'tasks', 't042', 'brief.md'), '# t042\n\n## Deliver\n- the parser\n');
    const lines = ['- 08-01  agreed     the header is parsed once, at the edge'];
    for (let i = 0; i < 30; i += 1) lines.push(`- 08-02  started    filler ${i}`);
    logLines(lines);
    mkdirSync(join(home, 'mem', 'learnings'), { recursive: true });
    writeFileSync(
      join(home, 'mem', 'learnings', 'folder-trust.md'),
      ['---', 'name: Folder trust', 'description: a new repo stops Claude on the trust dialog', '---', '', 'the fix is long', ''].join('\n'),
    );
    writeFileSync(join(home, 'mem', 'user.md'), 'prefers prose to bullet lists\n');

    const r = await runYan(home, ['session-start', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('- the parser');
    expect(r.stdout, 'an agreed entry is carried however old').toContain('the header is parsed once');
    expect(r.stdout, 'the tail is carried').toContain('filler 29');
    expect(r.stdout, 'older entries of other kinds are not').not.toContain('filler 9\n');
    expect(r.stdout).toContain('21 of 31 entries');
    expect(r.stdout).toContain('mem/learnings/folder-trust.md');
    expect(r.stdout).toContain('a new repo stops Claude on the trust dialog');
    expect(r.stdout, 'an index, not the text').not.toContain('the fix is long');
    expect(r.stdout).toContain('prefers prose to bullet lists');
  });

  it('prints none of it when no task is named', async () => {
    writeFileSync(join(home, 'mem', 'user.md'), 'prefers prose to bullet lists\n');
    const r = await runYan(home, ['session-start'], { YAN_TASK: '' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain('── brief');
    expect(r.stdout).not.toContain('prefers prose');
  });

  it('says so when the log is empty, and leaves out what does not exist', async () => {
    rmSync(join(home, 'mem', 'user.md'), { force: true });
    rmSync(join(home, 'mem', 'learnings'), { recursive: true, force: true });
    const r = await runYan(home, ['session-start', 't099']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('(nothing logged yet)');
    expect(r.stdout).not.toContain('── learnings');
    expect(r.stdout).not.toContain('── user');
  });

  it("says in one line that there are no drafts, and creates no folder for them", async () => {
    const r = await runYan(home, ['session-start', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain("── drafts  none yet (user writes them with 'yan draft')");
    expect(r.stdout.indexOf('── drafts'), 'after the brief').toBeGreaterThan(r.stdout.indexOf('── brief'));
    expect(r.stdout.indexOf('── drafts'), 'before the log').toBeLessThan(r.stdout.indexOf('── log'));
    expect(existsSync(join(home, 'tasks', 't042', 'artifacts', 'drafts'))).toBe(false);
  });

  it("lists the newest ten of user's drafts by id, date and title, and none of their text", async () => {
    const dir = join(home, 'tasks', 't042', 'artifacts', 'drafts');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i += 1) {
      const id = `2026-09-${String(i + 1).padStart(2, '0')}_090000`;
      const file = join(dir, `${id}.md`);
      writeFileSync(file, `# note ${i}\n\nthe body of note ${i}\n`);
      const t = new Date(2026, 8, i + 1, 9, 0, 0).getTime() / 1000;
      utimesSync(file, t, t);
    }

    const r = await runYan(home, ['session-start', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('── drafts  10 of 12');
    expect(r.stdout).toContain("user's own notes about this task");
    expect(r.stdout).toContain('yan draft cat <id>');
    expect(r.stdout, 'how to dig deeper').toContain("'yan draft ls --plain --limit <n>'");
    expect(r.stdout, 'where other tasks keep theirs').toContain('/tasks/<id>/artifacts/drafts/');
    expect(r.stdout).toContain('  2026-09-12_090000  2026-09-12 09:00  note 11');
    expect(r.stdout).toContain('note 2\n');
    expect(r.stdout, 'only the newest ten').not.toContain('note 1\n');
    expect(r.stdout, 'an index, not the text').not.toContain('the body of note');
  });

  it('leaves the drafts out of --json, which carries the queue rather than the memory', async () => {
    const dir = join(home, 'tasks', 't042', 'artifacts', 'drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-09-16_051516.md'), '# a note\n');
    const r = await runYan(home, ['session-start', 't042', '--json']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain('a note');
    expect(Object.keys(JSON.parse(r.stdout) as object).sort()).toEqual(['home', 'repos', 'tasks', 'version']);
  });

  it('still writes nothing', async () => {
    logLines(['- 08-01  agreed     x']);
    mkdirSync(join(home, 'tasks', 't042', 'artifacts', 'drafts'), { recursive: true });
    writeFileSync(join(home, 'tasks', 't042', 'artifacts', 'drafts', '2026-09-16_051516.md'), '# a note\n');
    const before = listing();
    await runYan(home, ['session-start', 't042']);
    expect(listing()).toBe(before);
  });
});

describe('the scenarios reach the session', () => {
  it('lists each scenario, its tiers and what each runs', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        version: 1,
        agents: { yan: 'claude', shift: { cli: 'claude', model: 'opus', effort: 'high' } },
        scenarios: {
          explore: { default: 'normal', tiers: { light: { description: 'find it', model: 'sonnet' }, normal: {} } },
          coding: { tiers: { normal: { description: 'an ordinary change' } } },
          uix: { tiers: { normal: { cli: 'agy', model: 'gemini-3.1-pro-high', skills: ['design'] } } },
        },
        remote_git: { kind: 'github' },
      }),
    );
    const r = await runYan(home, ['session-start', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('── scenarios');
    expect(r.stdout).toContain('explore — investigating');
    expect(r.stdout).toContain('light  claude sonnet high — find it');
    expect(r.stdout).toContain('normal (default)  claude opus high');
    expect(r.stdout).toContain('normal (default)  agy gemini-3.1-pro-high /design');
  });
});

/**
 * The reports that never reached yan. They belong to the main agent's picture
 * and to nobody else, and reading them is what clears them — one of the two
 * places `run/undelivered` is surfaced, the other being `yan show`.
 *
 * Cleared for the task this caller is the main agent of, and for no other:
 * a bare `session-start` prints every task on the machine, and the yan of
 * t042 starting up must not consume what the yan of t099 has not seen.
 */
describe('undelivered reports', () => {
  const kept = (): string => join(run, 'undelivered');

  function seed(): void {
    writeFileSync(kept(), '2025-09-11T08:00:00Z\tblocked\tthe auth fixture needs a credential\n2025-09-11T08:01:40Z\tneeds-decision\twhich target branch?\n');
  }

  it('prints every line, naming the shift, then removes the file', async () => {
    seed();
    const r = await runYan(home, ['session-start'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('undelivered reports');
    expect(r.stdout).toContain('the auth fixture needs a credential');
    expect(r.stdout).toContain('which target branch?');
    expect(r.stdout, 'the shift is named, since it is how yan answers').toMatch(/t042 {2}s2 {2}blocked/);
    expect(existsSync(kept()), 'printed is said').toBe(false);

    const again = await runYan(home, ['session-start'], { YAN_TASK: 't042' });
    expect(again.stdout, 'and it is not said twice').not.toContain('undelivered reports');
  });

  it('carries them into --json, and clears them there too', async () => {
    seed();
    const r = await runYan(home, ['session-start', '--json'], { YAN_TASK: 't042' });
    const picture = JSON.parse(r.stdout) as { tasks: { shifts: { sid: string; undelivered: unknown[] }[] }[] };
    expect(picture.tasks[0].shifts.find((s) => s.sid === 's2')?.undelivered).toEqual([
      { at: '2025-09-11T08:00:00Z', state: 'blocked', note: 'the auth fixture needs a credential' },
      { at: '2025-09-11T08:01:40Z', state: 'needs-decision', note: 'which target branch?' },
    ]);
    expect(existsSync(kept())).toBe(false);
  });

  it('is the main agent\'s to read: a shift firing the hook neither sees nor clears them', async () => {
    seed();
    const r = await runYan(home, ['session-start'], { YAN_TASK: 't042', YAN_SID: 's2' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain('undelivered');
    expect(existsSync(kept()), 'and a shift must not swallow them').toBe(true);
  });

  it("leaves another task's lines alone, and clears only its own", async () => {
    // t099 has a live shift of its own with a report nobody has read.
    const other = liveShift(home, 't099', 's9', { unit: 'api', pane: 'w2:p1' });
    writeFileSync(join(other, 'undelivered'), '2025-09-11T08:03:20Z\tblocked\tt099 is waiting on a credential\n');
    seed();

    const r = await runYan(home, ['session-start', '--all'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout, 'both are printed: nothing is hidden').toContain('the auth fixture needs a credential');
    expect(r.stdout).toContain('t099 is waiting on a credential');

    expect(existsSync(kept()), "this yan's own task is cleared").toBe(false);
    expect(existsSync(join(other, 'undelivered')), "t099's yan has not seen its own yet").toBe(true);
  });

  it('clears nothing at all when no task is named, as in a bare shell', async () => {
    seed();
    const r = await runYan(home, ['session-start', '--all'], { YAN_TASK: undefined });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('the auth fixture needs a credential');
    expect(existsSync(kept())).toBe(true);
  });

  it('says nothing at all when there are none', async () => {
    const r = await runYan(home, ['session-start'], { YAN_TASK: 't042' });
    expect(r.stdout).not.toContain('undelivered');
  });
});
