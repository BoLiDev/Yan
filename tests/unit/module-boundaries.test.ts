import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, repoRoot } from '../helpers/fixtures.js';

/**
 * The module-boundary lint rule, exercised against fixture trees.
 *
 * It lives in tests/unit/ rather than beside a module because it is not about
 * any one module: it is the rule that keeps every module's `index.ts` the whole
 * truth about that module. The checker is a build step (`npm run
 * lint:boundaries`, wired into `npm run build`), so the test runs the real
 * checker rather than asserting on its source.
 */

afterAll(cleanupTempDirs);

const checker = join(repoRoot, 'scripts', 'check-module-boundaries.mjs');

function lint(root: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function write(root: string, rel: string, source: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, source);
}

/** Every module needs an index.ts, so a fixture that omits one fails rule 4. */
function stubModule(root: string, name: string): void {
  write(root, `externals/${name}/index.ts`, `export {};\n`);
}

describe('rule 1: only index.ts may be imported from outside a module', () => {
  it('fails when something reaches past the entry point', () => {
    const root = mkTempDir();
    write(root, 'cli/tree.ts', `import { cloneDir } from '../externals/worktree/layout.js';\n`);
    write(root, 'externals/worktree/index.ts', `export {};\n`);
    write(root, 'externals/worktree/layout.ts', `export function cloneDir(): void {}\n`);

    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('only externals/worktree/index.ts may be imported');
  });

  it('allows the entry point itself', () => {
    const root = mkTempDir();
    write(root, 'cli/tree.ts', `import { WorktreePool } from '../externals/worktree/index.js';\n`);
    write(root, 'externals/worktree/index.ts', `export class WorktreePool {}\n`);

    expect(lint(root).code).toBe(0);
  });

  it("allows a module's own files to import each other, which is why the test lives inside", () => {
    const root = mkTempDir();
    write(root, 'externals/alpha/index.ts', `import { call } from './client.js';\n`);
    write(root, 'externals/alpha/client.ts', `export function call(): void {}\n`);
    write(root, 'externals/alpha/alpha.test.ts', `import './client.js';\n`);

    expect(lint(root).code).toBe(0);
  });
});

describe('rule 2: no sideways edges between modules', () => {
  it('fails when one external imports another', () => {
    const root = mkTempDir();
    // Deliberately not real module names: this test is about the rule, and a
    // fixture named after a real module gets damaged the next time one is
    // renamed. It was, once.
    write(root, 'externals/alpha/index.ts', `import { x } from '../beta/index.js';\n`);
    write(root, 'externals/beta/index.ts', `export const x = 1;\n`);

    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('externals/alpha may not import externals/beta');
  });

  it('allows an external to import src/util', () => {
    const root = mkTempDir();
    write(root, 'externals/remote-git/index.ts', `import { git } from '../../util/git.js';\n`);
    write(root, 'util/git.ts', `export function git(): void {}\n`);

    expect(lint(root).code).toBe(0);
  });
});

describe('rule 3: prompts stay in the cli', () => {
  it('fails when anything but src/cli imports src/ui', () => {
    const root = mkTempDir();
    write(root, 'store/task.ts', `import { ask } from '../ui/prompts.js';\n`);
    write(root, 'ui/prompts.ts', `export function ask(): void {}\n`);

    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('only src/cli/ may import src/ui/');
  });

  it('allows src/cli to import src/ui', () => {
    const root = mkTempDir();
    write(root, 'cli/task-new.ts', `import { ask } from '../ui/prompts.js';\n`);
    write(root, 'ui/prompts.ts', `export function ask(): void {}\n`);

    expect(lint(root).code).toBe(0);
  });
});

describe('rule 4: a module declares a surface or it is not a module', () => {
  it('fails a module directory with no index.ts', () => {
    const root = mkTempDir();
    write(root, 'externals/worktree/worktree.ts', `export class WorktreePool {}\n`);

    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('has no index.ts');
  });

  it('passes once the surface is declared', () => {
    const root = mkTempDir();
    stubModule(root, 'worktree');
    expect(lint(root).code).toBe(0);
  });
});

describe('the real tree', () => {
  it('passes', () => {
    const r = lint(join(repoRoot, 'src'));
    expect(r.code, r.out).toBe(0);
  });
});
