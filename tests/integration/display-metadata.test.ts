import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import {
  cleanupTempDirs,
  mkBareRemote,
  mkClone,
  mkTempDir,
  mkYanHome,
  registerRepo,
  repoRoot,
  runYan,
} from '../helpers/fixtures.js';
import { hostname } from 'node:os';
import { containerOf } from '../../src/cli/shared/container.js';
import { enterIdentity } from '../../src/cli/shared/enter-lock.js';
import { setUnit, type Labeller } from '../../src/cli/unit.js';
import { Task } from '../../src/records/task/index.js';

/**
 * The display-metadata calls, and the two
 * bullets that span every command rather than belonging to one.
 *
 *   "Workspace tokens and pane titles are set at the right moments,
 *    cleared on teardown, and a metadata failure logs one line without
 *    aborting the operation."
 *
 *   "`target` is never defaulted by any command."
 *
 * Herdr receives presentation, never truth: nothing reported here is ever read
 * back as a fact, so a refused call is a cosmetic bug and must never abort the
 * operation that made it.
 */

afterAll(cleanupTempDirs);

let home = '';
let previousHome: string | undefined;

class FakeLabeller implements Labeller {
  public readonly calls: { workspace: string; tokens: Record<string, string> }[] = [];
  public refuse = false;
  /** What the main agent's pane resolves to; undefined means "not under Herdr". */
  public paneWorkspace: string | undefined = undefined;

  public setWorkspaceTokens(workspace: string, tokens: Record<string, string>): void {
    if (this.refuse) throw new Error('herdr refused the tokens');
    this.calls.push({ workspace, tokens });
  }

  public workspaceOfPane(): string | undefined {
    return this.paneWorkspace;
  }
}

function liveShift(sid: string, container: string): void {
  const run = join(home, 'tasks', 't042', 'shifts', sid, 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'meta.json'), `${JSON.stringify({ version: 1, container, pane: 'w1:p2' })}\n`);
}

/** The lock `yan continue` holds, stamped with the pane the main agent is in. */
function enterLock(task: string, pane: string): void {
  writeFileSync(
    join(home, 'tasks', task, '.enter.lock'),
    `${JSON.stringify({ pid: process.pid, host: hostname(), at: 0, identity: enterIdentity(task, pane) })}\n`,
  );
}

beforeEach(async () => {
  previousHome = process.env.YAN_HOME;
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  process.env.YAN_HOME = home;
  await mkClone(await mkBareRemote(join(tmp, 'remote.git')), join(home, 'repos', 'monorepo-x'));
  // A clone is where the registry says it is now, not where a convention put
  // it. The path does not change; only the reason yan
  // can find it.
  registerRepo(home, 'monorepo-x', join(home, 'repos', 'monorepo-x'));

  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'main', { branch: 'main' });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('the workspace is derived, never created', () => {
  it('is undefined when nothing is running, because there is nothing to relabel', () => {
    expect(containerOf('t042')).toBeUndefined();
  });

  it('is the container a live shift recorded', () => {
    liveShift('s1', 'w3');
    expect(containerOf('t042')).toBe('w3');
  });

  it('falls back to the workspace the main agent is in', () => {
    // No shift has run yet, so the only thing on screen is `user`'s own pane
    // with yan in it. That is the container this task's tabs belong in, and
    // the enter lock is where its id is stamped.
    enterLock('t042', 'w7:p1');
    const terminal = new FakeLabeller();
    terminal.paneWorkspace = 'w7';
    expect(containerOf('t042', terminal)).toBe('w7');
  });

  it('prefers a live shift over the lock, so the answer cannot move mid-task', () => {
    liveShift('s1', 'w3');
    enterLock('t042', 'w7:p1');
    const terminal = new FakeLabeller();
    terminal.paneWorkspace = 'w7';
    expect(containerOf('t042', terminal)).toBe('w3');
  });

  it('is undefined when the lock names no pane, because yan is not under Herdr', () => {
    enterLock('t042', '');
    const terminal = new FakeLabeller();
    terminal.paneWorkspace = 'w7';
    expect(containerOf('t042', terminal)).toBeUndefined();
  });

  it('creates nothing, even handed a terminal that could', () => {
    // The relabelling callers pass a Terminal because they need
    // `workspaceOfPane`. That must not become a way to make a workspace: a
    // command that only wants to relabel has no business creating one.
    const terminal = {
      workspaceOfPane: () => undefined,
      createContainer: () => {
        throw new Error('containerOf must never create a container');
      },
    };
    expect(containerOf('t042', terminal)).toBeUndefined();
  });
});

describe('`unit set --branch` rewrites the tokens for the new round', () => {
  it('reports task, unit and branch', () => {
    liveShift('s1', 'w3');
    const labeller = new FakeLabeller();
    setUnit(
      { task: 't042', unit: 'auth', branch: 'feat/auth-r2', reason: 'starting again' },
      () => 'closed',
      labeller,
    );
    expect(labeller.calls).toEqual([
      { workspace: 'w3', tokens: { task: 't042', unit: 'auth', branch: 'feat/auth-r2' } },
    ]);
  });

  it('is never fatal: a refused call costs a line, not the rotation', () => {
    liveShift('s1', 'w3');
    const labeller = new FakeLabeller();
    labeller.refuse = true;

    setUnit(
      { task: 't042', unit: 'auth', branch: 'feat/auth-r2', reason: 'starting again' },
      () => 'closed',
      labeller,
    );
    // task.json moved on regardless: the work is correct with ugly labels.
    const unit = new Task('t042').unit('auth').read();
    expect(unit.branch).toBe('feat/auth-r2');
    expect(unit.history).toHaveLength(1);
  });
});

describe('every metadata call goes through the one door that cannot throw', () => {
  it('is `display()`, and no command calls the seam bare', () => {
    const files = readdirSync(join(repoRoot, 'src', 'cli')).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const lines = readFileSync(join(repoRoot, 'src', 'cli', file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/\.(setWorkspaceTokens|setPaneTitle|clearPaneTitle)\(/.test(line)) return;
        // The wrapper opens at most two lines above the call it guards.
        const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
        expect(window, `${file}:${i + 1} must be wrapped in display()`).toContain('display(');
      });
    }
  });
});

describe('`target` is never defaulted by any command', () => {
  it('is required outright by `unit add`', async () => {
    const r = await runYan(home, ['unit', 'add', '--task', 't042', '--unit', 'x', '--repo', 'monorepo-x']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('never guessed');
  });

  it('is never invented by the commands that read it', () => {
    // The other three readers - mr, land, shift new - take it from the
    // unit and refuse when it is empty. None of them may fall back to main,
    // master, or the current branch.
    for (const file of ['mr.ts', 'land.ts', 'shift.ts', 'unit.ts']) {
      const source = readFileSync(join(repoRoot, 'src', 'cli', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const guess of ["target ?? 'main'", "target ?? 'master'", "target || 'main'", "target: 'main'"]) {
        expect(source, `${file} must not default target`).not.toContain(guess);
      }
    }
  });

  it('is not defaulted anywhere in the command layer', () => {
    const files = readdirSync(join(repoRoot, 'src', 'cli')).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const source = readFileSync(join(repoRoot, 'src', 'cli', f), 'utf8');
      expect(/target\s*=\s*['"](main|master)['"]/.test(source), f).toBe(false);
    }
  });
});
