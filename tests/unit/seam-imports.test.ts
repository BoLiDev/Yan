import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, repoRoot } from '../helpers/fixtures.js';

/**
 * Phase 0 Trace: "The lint rule fails a build where one src/seams/* imports
 * another."
 *
 * The rule is a build step (`npm run lint:seams`, wired into `npm run build`
 * and `npm test`), so the test runs the real checker against a fixture tree
 * rather than asserting on its source.
 */

afterAll(cleanupTempDirs);

const checker = join(repoRoot, 'scripts', 'check-seam-imports.mjs');

function lint(root: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function write(root: string, rel: string, source: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, source);
}

describe('the seam-import lint rule', () => {
  it('fails when one seam imports another', () => {
    const root = mkTempDir();
    write(root, 'seams/forge/index.ts', `import { termList } from '../terminal/index.js';\n`);
    write(root, 'seams/terminal/index.ts', `export function termList(): void {}\n`);

    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a seam may not import another seam');
  });

  it('fails when anything but src/cli imports src/ui', () => {
    const root = mkTempDir();
    write(root, 'store/task.ts', `import { ask } from '../ui/prompts.js';\n`);
    write(root, 'ui/prompts.ts', `export function ask(): void {}\n`);

    const r = lint(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('only src/cli/ may import src/ui/');
  });

  it('allows src/cli to import src/ui, and a seam to import src/util', () => {
    const root = mkTempDir();
    write(root, 'cli/task-new.ts', `import { ask } from '../ui/prompts.js';\n`);
    write(root, 'ui/prompts.ts', `export function ask(): void {}\n`);
    write(root, 'seams/forge/index.ts', `import { git } from '../../util/git.js';\n`);
    write(root, 'util/git.ts', `export function git(): void {}\n`);

    expect(lint(root).code).toBe(0);
  });

  it('allows a seam to import within itself', () => {
    const root = mkTempDir();
    write(root, 'seams/terminal/index.ts', `import { call } from './client.js';\n`);
    write(root, 'seams/terminal/client.ts', `export function call(): void {}\n`);

    expect(lint(root).code).toBe(0);
  });

  it('passes on the real src/ tree', () => {
    expect(lint(join(repoRoot, 'src')).code).toBe(0);
  });
});
