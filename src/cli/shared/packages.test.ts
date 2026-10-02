import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspacePackages } from './packages.js';
import { cleanupTempDirs, mkTempDir } from '../../../tests/helpers/fixtures.js';

afterAll(cleanupTempDirs);

function repo(dirs: readonly string[], files: Record<string, string> = {}): string {
  const root = mkTempDir();
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

describe('workspacePackages', () => {
  it('reads pnpm-workspace.yaml and package.json workspaces, and expands only <dir>/*', () => {
    const root = repo(['libs/a', 'libs/b', 'tools/cli', 'deep/x/y'], {
      'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n  - '!libs/b'\n  - 'deep/**'\n",
      'package.json': JSON.stringify({ workspaces: { packages: ['tools/cli'] } }),
    });
    expect(workspacePackages(root)).toEqual(['libs/a', 'libs/b', 'tools/cli']);
  });

  it('takes packages/ and apps/ without a manifest, skipping dot directories and node_modules', () => {
    const root = repo(['packages/core', 'packages/.cache', 'packages/node_modules', 'apps/site']);
    expect(workspacePackages(root)).toEqual(['apps/site', 'packages/core']);
  });

  it('is empty for a repository that is one package', () => {
    expect(workspacePackages(repo(['src'], { 'package.json': '{"name":"x"}' }))).toEqual([]);
  });
});
