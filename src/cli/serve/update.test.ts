import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkCommit, mkTempDir } from '../../../tests/helpers/fixtures.js';
import { Updater, type UpdateState } from './update.js';

afterAll(cleanupTempDirs);

/** A yan clone of `bare` whose build writes built.txt, and another clone to push from. */
async function aYan(build = 'node -e "require(\'fs\').writeFileSync(\'built.txt\', require(\'fs\').readFileSync(\'README.md\'))"'): Promise<{ home: string; push: (body: string) => Promise<void> }> {
  const bare = await mkBareRemote(join(mkTempDir(), 'yan.git'));
  const elsewhere = await mkClone(bare, join(mkTempDir(), 'elsewhere'));
  await mkCommit(elsewhere, 'package.json', JSON.stringify({ name: 'yan-test', version: '0.0.0', private: true, scripts: { build } }), 'a package');
  await fxGit(['push', '-q', 'origin', 'main'], elsewhere);
  const home = await mkClone(bare, join(mkTempDir(), 'home'));
  return {
    home,
    push: async (body) => {
      await mkCommit(elsewhere, 'README.md', body, 'newer');
      await fxGit(['push', '-q', 'origin', 'main'], elsewhere);
    },
  };
}

/** The update once it is over, or once it is restarting serve, which ends this process when it is serve's. */
async function finished(u: Updater): Promise<UpdateState> {
  for (let i = 0; i < 600; i += 1) {
    if (!u.now.running || u.now.steps.some((s) => s.step === 'restart' && s.state === 'now')) return u.now;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the update did not finish');
}

describe('yan updating itself', () => {
  it('counts what its clone is behind, pulls it, installs, builds and restarts on the build', async () => {
    const { home, push } = await aYan();
    let restarts = 0;
    const u = new Updater(home, () => {
      restarts += 1;
      return 'restarting';
    });
    expect(await u.behind()).toEqual({ behind: 0 });
    await push('two\n');
    await push('three\n');
    expect(await u.behind()).toEqual({ behind: 2 });

    expect(u.start()).toBe(true);
    expect(u.start(), 'one update at a time').toBe(false);
    const done = await finished(u);
    expect(done.steps.map((s) => `${s.step} ${s.state}`)).toEqual(['pull done', 'install done', 'build done', 'restart now']);
    expect(done.error).toBeNull();
    expect(readFileSync(join(home, 'built.txt'), 'utf8').trim()).toBe('three');
    expect(restarts).toBe(1);
    expect(await u.behind()).toEqual({ behind: 0 });
  }, 120_000);

  it('stops at the step that fails and says why, and is done when the build is the one running', async () => {
    const { home, push } = await aYan('node -e "process.stderr.write(\'tsc: 3 errors\\\\n\'); process.exit(2)"');
    await push('two\n');
    const u = new Updater(home, () => 'same');
    u.start();
    const failed = await finished(u);
    expect(failed.steps.map((s) => `${s.step} ${s.state}`)).toEqual(['pull done', 'install done', 'build failed', 'restart wait']);
    expect(failed.error).toContain('tsc: 3 errors');
    expect(existsSync(join(home, 'built.txt'))).toBe(false);

    writeFileSync(join(home, 'package.json'), JSON.stringify({ name: 'yan-test', version: '0.0.0', private: true, scripts: { build: 'node -e ""' } }));
    u.start();
    expect((await finished(u)).steps.map((s) => s.state), 'nothing new to restart on').toEqual(['done', 'done', 'done', 'done']);
  }, 120_000);

  it('says so of a folder that is not a clone', async () => {
    expect(await new Updater(mkTempDir(), () => 'same').behind()).toEqual({ error: expect.stringContaining('不是 git 仓库') });
  });
});
