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
import { containerOf } from '../../src/cli/shared/display.js';
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

  public setWorkspaceTokens(workspace: string, tokens: Record<string, string>): void {
    if (this.refuse) throw new Error('herdr refused the tokens');
    this.calls.push({ workspace, tokens });
  }
}

function liveShift(sid: string, container: string): void {
  const run = join(home, 'tasks', 't042', 'shifts', sid, 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'meta.json'), `${JSON.stringify({ version: 1, container, pane: 'w1:p2' })}\n`);
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

  it('never reaches for `workspace create`, which would make one', () => {
    // The doc comment names it to say why; the code may not call it.
    const source = readFileSync(join(repoRoot, 'src', 'cli', 'shared', 'display.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(source).not.toContain('createContainer');
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
