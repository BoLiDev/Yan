import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkTempDir, mkYanHome, registerRepo } from '../helpers/fixtures.js';
import { scan } from '../../src/cli/repo.js';

/**
 * `yan repo add`'s scan.
 *
 * The interactive half cannot be driven from a test — there is no terminal —
 * but the interesting half is not interactive: which directories are offered,
 * and what is said about the ones that cannot be taken. That is a pure
 * function over a directory, so it is tested as one.
 */

afterAll(cleanupTempDirs);

let root = '';
let home = '';

async function clone(name: string, withRemote = true): Promise<string> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  await fxGit(['init', '--initial-branch=main', '.'], dir);
  if (withRemote) await fxGit(['remote', 'add', 'origin', `git@host:org/${name}.git`], dir);
  return dir;
}

beforeAll(async () => {
  const tmp = mkTempDir('yan-scan-');
  home = mkYanHome(join(tmp, 'home'), {});
  root = join(tmp, 'code');
  mkdirSync(root, { recursive: true });

  await clone('alpha');
  await clone('beta');
  await clone('no-remote', false);

  // Not a clone at all, and a nested one that the scan must not reach.
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'todo.md'), 'nothing to see\n');
  await clone(join('alpha', 'vendored'));
});

describe('one level, and everything visible', () => {
  it('finds the clones directly under the directory and nothing deeper', () => {
    const names = scan(root).map((c) => c.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    // `notes` is not a clone; `vendored` is one level too deep. Recursion would
    // find every vendored checkout in node_modules, which nobody wants.
    expect(names).not.toContain('notes');
    expect(names).not.toContain('vendored');
  });

  it('lists a clone with no origin, disabled, with the reason', () => {
    const found = scan(root).find((c) => c.name === 'no-remote');
    expect(found, 'silently skipping it would look like a bug in the scan').toBeDefined();
    expect(found?.blocked).toContain('no origin');
  });

  it('reads the name from origin, not from the directory it happens to sit in', async () => {
    const dir = join(root, 'directory-name');
    mkdirSync(dir, { recursive: true });
    await fxGit(['init', '--initial-branch=main', '.'], dir);
    await fxGit(['remote', 'add', 'origin', 'git@host:org/real-name.git'], dir);

    const found = scan(root).find((c) => c.dir.endsWith('directory-name'));
    expect(found?.name).toBe('real-name');
  });

  it('says which candidates are already registered rather than offering them twice', () => {
    registerRepo(home, 'alpha', join(root, 'alpha'), { url: 'git@host:org/alpha.git' });
    const found = scan(root).find((c) => c.name === 'alpha');
    expect(found?.blocked).toBe('already registered');
  });
});
