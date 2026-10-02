import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkBareRemote, mkClone, mkTempDir, mkYanHome, restoreVault, runYan, useVault } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { registry } from '../../src/records/repos/index.js';
import { Task } from '../../src/records/task/index.js';
import { normalizePath } from '../../src/util/paths.js';

/**
 * `yan repo`: the vault keeps which repositories the context works in, the
 * machine keeps where each is cloned, and nothing here touches a clone.
 */

afterAll(cleanupTempDirs);

let home = '';

function yan(args: readonly string[], cwd?: string) {
  return runYan(home, args, {}, cwd);
}

async function aClone(name: string): Promise<{ bare: string; clone: string }> {
  const bare = await mkBareRemote(join(mkTempDir(), `${name}.git`));
  return { bare, clone: normalizePath(realpathSync(await mkClone(bare, join(mkTempDir(), name)))) };
}

beforeEach(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  useVault(home);
});

afterEach(restoreVault);

describe('yan repo add', () => {
  it('registers a clone by path, the clone it is typed in, and keeps where it is out of the vault', async () => {
    const web = await aClone('web');
    const api = await aClone('api');
    expect((await yan(['repo', 'add', web.clone])).code).toBe(0);
    expect((await yan(['repo', 'add'], api.clone)).code).toBe(0);

    expect(registry()).toEqual([
      { name: 'api', url: api.bare, clone: api.clone },
      { name: 'web', url: web.bare, clone: web.clone },
    ]);
    const vaultHalf = readFileSync(join(home, 'repos.json'), 'utf8');
    expect(vaultHalf).toContain(web.bare);
    expect(vaultHalf, 'paths are this machine\'s').not.toContain(web.clone);
  });

  it('clones a URL into the current directory, or keeps a clone of it already there', async () => {
    const { bare } = await aClone('web');
    const into = normalizePath(realpathSync(mkTempDir()));
    const r = await yan(['repo', 'add', bare, '--name', 'site'], into);
    expect(r.code, r.out).toBe(0);
    expect(registry()).toEqual([{ name: 'site', url: bare, clone: join(into, 'site') }]);

    const again = await yan(['repo', 'add', bare, '--name', 'site'], into);
    expect(again.code, again.out).toBe(0);
    expect(again.stdout).toContain('already a clone of it');
  });

  it('refuses a name another repository has, and a clone with no origin', async () => {
    const web = await aClone('web');
    const other = await aClone('other');
    await yan(['repo', 'add', web.clone]);
    const r = await yan(['repo', 'add', other.clone, '--name', 'web']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("'web' is already registered");

    const bare = join(mkTempDir(), 'no-origin');
    mkdirSync(join(bare, '.git'), { recursive: true });
    expectUsage(await yan(['repo', 'add', bare]), 'has no origin');
    expectUsage(await yan(['repo', 'add', join(mkTempDir(), 'nothing-here')]), 'is neither a clone URL nor a clone');
  });
});

describe('yan repo link, ls and rm', () => {
  it('links another clone of a registered repository, and refuses a clone of something else', async () => {
    const web = await aClone('web');
    await yan(['repo', 'add', web.clone]);
    const second = normalizePath(realpathSync(await mkClone(web.bare, join(mkTempDir(), 'second'))));
    expect((await yan(['repo', 'link', 'web', second])).code).toBe(0);
    expect(registry()[0]?.clone).toBe(second);

    const other = await aClone('other');
    expectUsage(await yan(['repo', 'link', 'web', other.clone]), 'is not a clone of');
  });

  it('lists what is registered, and keeps a repository an open task works in', async () => {
    const web = await aClone('web');
    await yan(['repo', 'add', web.clone]);
    const ls = await yan(['repo', 'ls']);
    expect(ls.stdout).toContain('web');
    expect(ls.stdout).toContain(web.bare);

    Task.create('x', [{ url: web.bare }]);
    const refused = await yan(['repo', 'rm', 'web']);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('t001');

    new Task('t001').close('done');
    expect((await yan(['repo', 'rm', 'web'])).code).toBe(0);
    expect(registry()).toEqual([]);
  });
});
