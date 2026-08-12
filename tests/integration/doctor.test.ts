import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot, runYan } from '../helpers/fixtures.js';

/**
 * `yan doctor`.
 *
 * The whole checklist runs in one place, and there are no rows for `jq`,
 * `backend` or `winpty`: nothing shells out, there is one terminal, and a
 * native process in a Herdr pane already gets a real console.
 *
 * What is checked, because each row caught something real:
 *
 *   Only the CLI the configured kind names is checked, never both. A machine
 *   that delivers to GitHub has no reason to install `glab`, and reporting its
 *   absence trains people to ignore doctor.
 *
 *   The commit identity is a failure, not a warning. Every shift commits in a
 *   leased worktree, which sees only the global config - so an identity that
 *   lives in a repository's own .git/config reads as healthy from inside the
 *   checkout and is invisible where it is needed. `git commit` then fails after
 *   the work is done.
 *
 * Nothing here touches the network.
 */

afterAll(cleanupTempDirs);

let home = '';

function config(body: Record<string, unknown>): void {
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(body, null, 2)}\n`);
}

/** Doctor, with git pointed at configuration files this test owns. */
async function doctor(env: Record<string, string> = {}) {
  return await runYan(home, ['doctor'], env);
}

let emptyGlobal = '';
let emptySystem = '';
let goodGlobal = '';

beforeAll(() => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });

  emptyGlobal = join(tmp, 'empty-global');
  emptySystem = join(tmp, 'empty-system');
  goodGlobal = join(tmp, 'good-global');
  writeFileSync(emptyGlobal, '');
  writeFileSync(emptySystem, '');
  writeFileSync(goodGlobal, '[user]\n\tname = Test Person\n\temail = test@example.invalid\n');
});

describe('the checklist', () => {
  it('reports git, node, the config and the agents', async () => {
    const r = await doctor();
    for (const needle of ['yan doctor', 'YAN_HOME', 'git', 'node', 'yan on PATH', 'config.json', 'agents.yan', 'agents.shift']) {
      expect(r.out, needle).toContain(needle);
    }
  });

  it('names none of the three checks that went with the tmux runtime', async () => {
    const r = await doctor();
    for (const gone of ['winpty', 'backend', 'tmux']) {
      expect(r.out, gone).not.toContain(gone);
    }
  });
});

describe('only the CLI the configured kind names', () => {
  it('checks gh for github, and never mentions glab', async () => {
    config({ version: 1, agents: { yan: 'claude', shift: 'claude' }, remote_git: { kind: 'github' } });
    const r = await doctor();
    expect(r.out).toContain('remote host (gh)');
    expect(r.out, 'only the CLI selected by the kind may be checked').not.toContain('glab');
  });

  it('checks glab for gitlab, and never mentions gh on its own', async () => {
    config({ version: 1, agents: { yan: 'claude', shift: 'claude' }, remote_git: { kind: 'gitlab', host: 'gitlab.example.invalid' } });
    expect((await doctor()).out).toContain('remote host (glab)');
  });

  it('fails on a kind it does not support, and on none at all', async () => {
    config({ version: 1, agents: { yan: 'claude', shift: 'claude' }, remote_git: { kind: 'bitbucket' } });
    let r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain('bitbucket');

    config({ version: 1, agents: { yan: 'claude', shift: 'claude' } });
    r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain('kind is not set');
  });
});

describe('a missing configuration is reported, not a crash', () => {
  it('says which file and what to copy', async () => {
    rmSync(join(home, 'config.json'));
    const r = await doctor();
    expect(r.code).toBe(1);
    expect(r.out).toContain('templates/vault/config.json');
    config({ version: 1, agents: { yan: 'claude', shift: 'claude' }, remote_git: { kind: 'github' } });
  });
});

describe('a commit identity every leased worktree can see', () => {
  it('is a failure when there is no global one, and says why', async () => {
    const r = await doctor({ GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_SYSTEM: emptySystem });
    expect(r.code, 'a missing commit identity is a failure, not a warning').toBe(1);
    expect(r.out).toContain('git identity');
    expect(r.out).toContain('leased worktree');
  });

  it('is satisfied by a global one', async () => {
    const r = await doctor({ GIT_CONFIG_GLOBAL: goodGlobal, GIT_CONFIG_SYSTEM: emptySystem });
    expect(r.out).toContain('Test Person <test@example.invalid>');
  });
});

describe("codex's first-run gates are reported before a dispatch meets them", () => {
  it('says nothing when no role is codex', async () => {
    config({ version: 1, agents: { yan: 'claude', shift: 'claude' }, remote_git: { kind: 'github' } });
    expect((await doctor()).out).not.toContain('hook review');
  });

  it('names both gates, and which of the two supervision can see', async () => {
    config({ version: 1, agents: { yan: 'codex', shift: 'codex' }, remote_git: { kind: 'github' } });
    const r = await doctor();

    // The one that hangs silently: Herdr reads "Hooks need review" as `idle`,
    // so nothing wakes. This home has never been trusted by codex, which is the
    // state every fresh machine is in.
    expect(r.out).toContain('hook review');
    expect(r.out).toContain('Hooks need review');
    expect(r.out).toContain('--dangerously-bypass-hook-trust');

    // And the one that does escalate, so it is reported as the lesser problem.
    expect(r.out).toContain('directory trust');
    expect(r.out).toContain('blocked');
  });

  it('drops the dispatch half when only the main agent is codex', async () => {
    config({ version: 1, agents: { yan: 'codex', shift: 'claude' }, remote_git: { kind: 'github' } });
    expect((await doctor()).out).toContain('agents.shift is not codex');
    config({ version: 1, agents: { yan: 'claude', shift: 'claude' }, remote_git: { kind: 'github' } });
  });
});

// The template a vault is born with is the sample: conf/ held nothing else
// once the real config moved into the vault, so it is gone.
describe('the shipped template config', () => {
  it('is valid and carries what doctor asks for', () => {
    const sample = JSON.parse(
      readFileSync(join(repoRoot, 'templates', 'vault', 'config.json'), 'utf8'),
    ) as { version: number; agents?: Record<string, string>; forge?: { kind?: string }; remote_git?: { kind?: string } };
    expect(sample.version).toBe(1);
    expect(sample.agents?.yan).toBeTruthy();
    expect(sample.agents?.shift).toBeTruthy();
    expect(sample.remote_git?.kind ?? sample.forge?.kind).toBeTruthy();
  });
});
