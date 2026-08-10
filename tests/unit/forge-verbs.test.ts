import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../helpers/fixtures.js';
import type { ForgeInvocation, ForgeResult } from '../../src/seams/forge/client.js';

/**
 * The four verbs, with the CLI transport replaced BY IMPORT rather than by an
 * environment-variable trick (plan/conventions.md §5). What is asserted here is
 * the part the mappers cannot cover:
 *
 *   - callers see only forge vocabulary; no gh / glab flag leaks upward, and
 *     none can be smuggled downward either;
 *   - only the CLI named by `forge.kind` is ever invoked;
 *   - an unreachable forge is `unknown` / `pending`, never a crash;
 *   - glab's `--auto-merge` default of TRUE is turned off, or "merge it" would
 *     silently become "merge it later".
 */

const calls: ForgeInvocation[] = [];
let nextResult: ForgeResult = { code: 0, stdout: '', stderr: '' };

vi.mock('../../src/seams/forge/client.js', () => ({
  CLI_MISSING: 127,
  runForgeCli: (invocation: ForgeInvocation): ForgeResult => {
    calls.push(invocation);
    return nextResult;
  },
}));

let home = '';
let previousHome: string | undefined;

function configure(forge: Record<string, unknown>): void {
  writeFileSync(
    join(home, 'conf', 'config.json'),
    `${JSON.stringify({ version: 1, agents: { yan: 'claude', shift: 'claude' }, forge }, null, 2)}\n`,
  );
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
  calls.length = 0;
  nextResult = { code: 0, stdout: '', stderr: '' };
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

afterAll(cleanupTempDirs);

async function forge() {
  return import('../../src/seams/forge/index.js');
}

describe('only the CLI named by forge.kind is ever invoked', () => {
  it('github reaches gh and never glab', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    nextResult = { code: 0, stdout: '{"state":"OPEN","mergedAt":null}', stderr: '' };
    expect(f.forgeMrState({ mr: 'https://github.com/o/r/pull/1' })).toBe('open');
    expect(calls.map((c) => c.cli)).toEqual(['gh']);
    expect(f.forgeCli()).toBe('gh');
  });

  it('gitlab reaches glab and never gh', async () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    const f = await forge();
    nextResult = { code: 0, stdout: '{"state":"opened","merged_at":null}', stderr: '' };
    expect(f.forgeMrState({ mr: 'https://gitlab.example.com/o/r/-/merge_requests/7' })).toBe('open');
    expect(calls.map((c) => c.cli)).toEqual(['glab']);
    expect(f.forgeCli()).toBe('glab');
  });

  it('refuses a configuration it cannot act on, rather than guessing', async () => {
    const f = await forge();
    configure({});
    expect(() => f.forgeMrState({ mr: '1' })).toThrow(/forge.kind is not set/);
    configure({ kind: 'bitbucket' });
    expect(() => f.forgeMrState({ mr: '1' })).toThrow(/does not support/);
    // GitLab has no usable default host, so a missing one is a refusal.
    configure({ kind: 'gitlab' });
    expect(() => f.forgeMrState({ mr: '1' })).toThrow(/forge.host is required/);
  });
});

describe('host routing is routing, not authentication', () => {
  it('leaves GH_HOST alone for github.com and sets it otherwise', async () => {
    const f = await forge();
    configure({ kind: 'github', host: 'github.com' });
    nextResult = { code: 0, stdout: '{}', stderr: '' };
    f.forgeMrState({ mr: '1' });
    expect(calls[0]?.host).toBeUndefined();

    calls.length = 0;
    configure({ kind: 'github', host: 'github.example.com' });
    f.forgeMrState({ mr: '1' });
    expect(calls[0]?.host).toBe('github.example.com');
  });
});

describe('no gh or glab flag can be smuggled through', () => {
  it('refuses an option the verb did not declare', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    // The compiler refuses this too; this is the runtime half, for a caller
    // that arrived through JSON or through `unknown`.
    const smuggled = { mr: '1', admin: true } as unknown as { mr: string };
    expect(() => f.forgeMrState(smuggled)).toThrow(/never gh's or glab's/);
    expect(calls).toHaveLength(0);
  });

  it('requires an mr reference at all', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    expect(() => f.forgeMrState({ mr: '' })).toThrow(/mr is required/);
  });
});

describe('an unreachable forge is a value, not a crash', () => {
  it('reports unknown for the state and pending for CI', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    nextResult = { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest' };
    expect(f.forgeMrState({ mr: '1' })).toBe('unknown');
    expect(f.forgeCiState({ mr: '1' })).toBe('pending');
  });

  it('reports the same way when the CLI is not installed at all', async () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    const f = await forge();
    nextResult = { code: 127, stdout: '', stderr: 'lib-forge: glab is not on PATH' };
    expect(f.forgeMrState({ mr: '3' })).toBe('unknown');
    expect(f.forgeCiState({ mr: '3' })).toBe('pending');
  });
});

describe('forgeMrCreate', () => {
  it('shapes gh pr create and returns only the URL', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    nextResult = {
      code: 0,
      stdout: 'Creating pull request\nhttps://github.com/o/r/pull/31\n',
      stderr: '',
    };
    const url = f.forgeMrCreate({
      source: 'feat/auth',
      target: 'master',
      title: 'unify the auth header',
      body: 'why',
      draft: true,
      repo: 'o/r',
    });
    expect(url).toBe('https://github.com/o/r/pull/31');
    expect(calls[0]?.args).toEqual([
      'pr',
      'create',
      '--base',
      'master',
      '--head',
      'feat/auth',
      '--title',
      'unify the auth header',
      '--body',
      'why',
      '--draft',
      '--repo',
      'o/r',
    ]);
  });

  it('keeps glab non-interactive and reads the URL off either stream', async () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    const f = await forge();
    nextResult = {
      code: 0,
      stdout: '',
      stderr: 'creating…\nhttps://gitlab.example.com/o/r/-/merge_requests/7\n',
    };
    const url = f.forgeMrCreate({ source: 'a', target: 'b', title: 't' });
    expect(url).toBe('https://gitlab.example.com/o/r/-/merge_requests/7');
    expect(calls[0]?.args).toContain('--no-editor');
    expect(calls[0]?.args).toContain('--yes');
  });

  it('refuses body and bodyFile together, and a missing source or title', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    const bodyFile = join(mkTempDir(), 'body.md');
    writeFileSync(bodyFile, 'from a file\n');

    expect(() =>
      f.forgeMrCreate({ source: 'a', target: 'b', title: 't', body: 'x', bodyFile }),
    ).toThrow(/alternatives/);
    expect(() => f.forgeMrCreate({ source: '', target: 'b', title: 't' })).toThrow(
      /source and target/,
    );
    expect(() => f.forgeMrCreate({ source: 'a', target: 'b', title: '' })).toThrow(/title/);

    nextResult = { code: 0, stdout: 'https://github.com/o/r/pull/1', stderr: '' };
    f.forgeMrCreate({ source: 'a', target: 'b', title: 't', bodyFile });
    expect(calls.at(-1)?.args).toContain('from a file\n');
  });

  it('says so plainly when the forge printed no URL', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    nextResult = { code: 0, stdout: 'nothing useful', stderr: '' };
    expect(() => f.forgeMrCreate({ source: 'a', target: 'b', title: 't' })).toThrow(
      /did not print a merge request URL/,
    );
  });
});

describe('forgeMrMerge', () => {
  it('maps the strategy and leaves the source branch alone by default', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    f.forgeMrMerge({ mr: 'https://github.com/o/r/pull/1' });
    expect(calls[0]?.args).toEqual(['pr', 'merge', 'https://github.com/o/r/pull/1', '--merge']);
    // worktree.md §7: `yan shift done` returns the tree and THEN deletes the
    // remote branch, so a forge that deleted it during the merge would take
    // that step away.
    expect(calls[0]?.args).not.toContain('--delete-branch');
  });

  it('turns glab --auto-merge off', async () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    const f = await forge();
    f.forgeMrMerge({ mr: '7', repo: 'o/r', strategy: 'squash', deleteSource: true });
    expect(calls[0]?.args).toEqual([
      'mr',
      'merge',
      '7',
      '--repo',
      'o/r',
      '--yes',
      '--auto-merge=false',
      '--squash',
      '--remove-source-branch',
    ]);
  });

  it('refuses a strategy that is not one of the three', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    expect(() =>
      f.forgeMrMerge({ mr: '1', strategy: 'ship-it' as unknown as 'merge' }),
    ).toThrow(/unknown merge strategy/);
  });

  it('throws when the merge did not happen', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    nextResult = { code: 1, stdout: '', stderr: 'not mergeable' };
    expect(() => f.forgeMrMerge({ mr: '1' })).toThrow(/could not merge/);
  });
});

describe('reference shaping', () => {
  it('gh takes a URL verbatim and does not also get --repo', async () => {
    configure({ kind: 'github' });
    const f = await forge();
    nextResult = { code: 0, stdout: '{}', stderr: '' };
    f.forgeMrState({ mr: 'https://github.com/o/r/pull/1', repo: 'o/r' });
    expect(calls[0]?.args).toEqual(['pr', 'view', 'https://github.com/o/r/pull/1', '--json', 'state,mergedAt']);
  });

  it('glab gets an iid and a project split out of the URL', async () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    const f = await forge();
    nextResult = { code: 0, stdout: '{}', stderr: '' };
    f.forgeMrState({ mr: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/42?tab=x' });
    expect(calls[0]?.args).toEqual([
      'mr',
      'view',
      '42',
      '--repo',
      'group/sub/proj',
      '--output',
      'json',
    ]);
  });

  it('refuses a reference glab could never use', async () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    const f = await forge();
    expect(() => f.forgeMrState({ mr: 'feat/auth' })).toThrow(/cannot work out the merge request number/);
  });
});
