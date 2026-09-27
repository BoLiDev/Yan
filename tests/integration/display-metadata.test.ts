import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
import { expectUsage } from '../helpers/usage.js';
import { enterLock, liveShift, seedT042 } from '../helpers/records.js';
import { containerOf } from '../../src/cli/shared/container.js';
import { setUnit, type Labeller } from '../../src/cli/unit.js';
import { Task } from '../../src/records/task/index.js';

/**
 * Two claims that span every command rather than belonging to one: workspace
 * tokens and pane titles are set and cleared at the right moments and never
 * abort the operation that set them, and `target` is never defaulted.
 */

afterAll(cleanupTempDirs);

let home = '';

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

/** A live shift of t042 in the given workspace. */
function running(sid: string, container: string): void {
  liveShift(home, 't042', sid, { container, pane: 'w1:p2' });
}

beforeEach(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  await mkClone(await mkBareRemote(join(tmp, 'remote.git')), join(home, 'repos', 'monorepo-x'));
  registerRepo(home, 'monorepo-x', join(home, 'repos', 'monorepo-x'));

  seedT042({ target: 'main', branch: 'main', scope: [] });
});


describe('the workspace is derived, never created', () => {
  it('is undefined when nothing is running, because there is nothing to relabel', () => {
    expect(containerOf('t042')).toBeUndefined();
  });

  it('is the container a live shift recorded', () => {
    running('s1', 'w3');
    expect(containerOf('t042')).toBe('w3');
  });

  it('falls back to the workspace the main agent is in', () => {
    // No shift has run yet, so the container comes from the pane stamped on
    // the enter lock.
    enterLock(home, 't042', 'w7:p1');
    const terminal = new FakeLabeller();
    terminal.paneWorkspace = 'w7';
    expect(containerOf('t042', terminal)).toBe('w7');
  });

  it('prefers a live shift over the lock, so the answer cannot move mid-task', () => {
    running('s1', 'w3');
    enterLock(home, 't042', 'w7:p1');
    const terminal = new FakeLabeller();
    terminal.paneWorkspace = 'w7';
    expect(containerOf('t042', terminal)).toBe('w3');
  });

  it('is undefined when the lock names no pane, because yan is not under Herdr', () => {
    enterLock(home, 't042', '');
    const terminal = new FakeLabeller();
    terminal.paneWorkspace = 'w7';
    expect(containerOf('t042', terminal)).toBeUndefined();
  });

  it('creates nothing, even handed a terminal that could', () => {
    // A relabelling caller passes a Terminal for `workspaceOfPane`, which must
    // not become a way to make a workspace.
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
    running('s1', 'w3');
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
    running('s1', 'w3');
    const labeller = new FakeLabeller();
    labeller.refuse = true;

    setUnit(
      { task: 't042', unit: 'auth', branch: 'feat/auth-r2', reason: 'starting again' },
      () => 'closed',
      labeller,
    );
    // task.json moved on regardless: the work is correct with ugly labels.
    const unit = new Task('t042').unit('auth');
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
    const r = await runYan(home, ['unit', 'add', '--unit', 'x', '--repo', 'monorepo-x'], { YAN_TASK: 't042' });
    expectUsage(r, 'never guessed');
  });

  it('is never invented by the commands that read it', () => {
    // mr, land and shift new take it from the unit and refuse when it is
    // empty: never main, master, or the current branch.
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
