import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import type { CliInvocation, CliResult } from './client.js';
import { RemoteGit, configuredCli } from './index.js';

/**
 * The four verbs, with the CLI transport replaced through the constructor.
 *
 * No module mocking: `new RemoteGit({ run })` is the supported way to route the
 * calls somewhere else, so the test uses the same door a caller would. What is
 * asserted here is the part the mappers cannot cover:
 *
 *   - callers see only yan vocabulary; no gh / glab flag leaks upward, and none
 *     can be smuggled downward either;
 *   - only the CLI named by the configured kind is ever invoked;
 *   - an unreachable host is `unknown` / `pending`, never a crash;
 *   - glab's `--auto-merge` default of true is turned off, or "merge it" would
 *     silently become "merge it later".
 */

const calls: CliInvocation[] = [];
let nextResult: CliResult = { code: 0, stdout: '', stderr: '' };

const run = (invocation: CliInvocation): CliResult => {
  calls.push(invocation);
  return nextResult;
};

/** The configuration is read in the constructor, so configure() comes first. */
function host(): RemoteGit {
  return new RemoteGit({ run });
}

let home = '';
let previousHome: string | undefined;

function configure(remoteGit: Record<string, unknown>): void {
  writeFileSync(
    join(home, 'config.json'),
    `${JSON.stringify(
      { version: 1, agents: { yan: 'claude', shift: 'claude' }, remote_git: remoteGit },
      null,
      2,
    )}\n`,
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

describe('only the CLI named by the configured kind is ever invoked', () => {
  it('github reaches gh and never glab', () => {
    configure({ kind: 'github' });
    nextResult = { code: 0, stdout: '{"state":"OPEN","mergedAt":null}', stderr: '' };
    expect(host().mrState({ mr: 'https://github.com/o/r/pull/1' })).toBe('open');
    expect(calls.map((c) => c.cli)).toEqual(['gh']);
    expect(configuredCli()).toBe('gh');
  });

  it('gitlab reaches glab and never gh', () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    nextResult = { code: 0, stdout: '{"state":"opened","merged_at":null}', stderr: '' };
    expect(host().mrState({ mr: 'https://gitlab.example.com/o/r/-/merge_requests/7' })).toBe('open');
    expect(calls.map((c) => c.cli)).toEqual(['glab']);
    expect(configuredCli()).toBe('glab');
  });

  it('refuses a configuration it cannot act on, at construction rather than later', () => {
    configure({});
    expect(() => host()).toThrow(/remote_git.kind is not set/);
    configure({ kind: 'bitbucket' });
    expect(() => host()).toThrow(/does not support/);
    // GitLab has no usable default host, so a missing one is a refusal.
    configure({ kind: 'gitlab' });
    expect(() => host()).toThrow(/remote_git.host is required/);
    expect(calls).toHaveLength(0);
  });

  it('reads only the current config section, and says what to rename', () => {
    // There is one spelling of the key, deliberately: two of them outlive their
    // reason by years, and the second is always the one somebody edits.
    //
    // `forge` is still looked for, because the difference between "you have not
    // configured a host" and "it is under the old name" is the difference
    // between a puzzle and a one-line fix.
    writeFileSync(
      join(home, 'config.json'),
      `${JSON.stringify({ version: 1, forge: { kind: 'github' } }, null, 2)}\n`,
    );
    expect(() => host().mrState({ mr: '1' })).toThrow(/rename that section to `remote_git`/);
    expect(calls).toHaveLength(0);
  });
});

describe('host routing is routing, not authentication', () => {
  it('leaves GH_HOST alone for github.com and sets it otherwise', () => {
    configure({ kind: 'github', host: 'github.com' });
    nextResult = { code: 0, stdout: '{}', stderr: '' };
    host().mrState({ mr: '1' });
    expect(calls[0]?.host).toBeUndefined();

    calls.length = 0;
    configure({ kind: 'github', host: 'github.example.com' });
    host().mrState({ mr: '1' });
    expect(calls[0]?.host).toBe('github.example.com');
  });
});

describe('no gh or glab flag can be smuggled through', () => {
  it('refuses an option the verb did not declare', () => {
    configure({ kind: 'github' });
    // The compiler refuses this too; this is the runtime half, for a caller
    // that arrived through JSON or through `unknown`.
    const smuggled = { mr: '1', admin: true } as unknown as { mr: string };
    expect(() => host().mrState(smuggled)).toThrow(/never gh's or glab's/);
    expect(calls).toHaveLength(0);
  });

  it('requires an mr reference at all', () => {
    configure({ kind: 'github' });
    expect(() => host().mrState({ mr: '' })).toThrow(/mr is required/);
  });
});

describe('an unreachable host is a value, not a crash', () => {
  it('reports unknown for the state and pending for CI', () => {
    configure({ kind: 'github' });
    const gh = host();
    nextResult = { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest' };
    expect(gh.mrState({ mr: '1' })).toBe('unknown');
    expect(gh.ciState({ mr: '1' })).toBe('pending');
  });

  it('reports the same way when the CLI is not installed at all', () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    const gl = host();
    nextResult = { code: 127, stdout: '', stderr: 'remote-git: glab is not on PATH' };
    expect(gl.mrState({ mr: '3' })).toBe('unknown');
    expect(gl.ciState({ mr: '3' })).toBe('pending');
  });
});

describe('createMr', () => {
  it('shapes gh pr create and returns only the URL', () => {
    configure({ kind: 'github' });
    nextResult = {
      code: 0,
      stdout: 'Creating pull request\nhttps://github.com/o/r/pull/31\n',
      stderr: '',
    };
    const url = host().createMr({
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

  it('keeps glab non-interactive and reads the URL off either stream', () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    nextResult = {
      code: 0,
      stdout: '',
      stderr: 'creating…\nhttps://gitlab.example.com/o/r/-/merge_requests/7\n',
    };
    const url = host().createMr({ source: 'a', target: 'b', title: 't' });
    expect(url).toBe('https://gitlab.example.com/o/r/-/merge_requests/7');
    expect(calls[0]?.args).toContain('--no-editor');
    expect(calls[0]?.args).toContain('--yes');
  });

  it('refuses body and bodyFile together, and a missing source or title', () => {
    configure({ kind: 'github' });
    const gh = host();
    const bodyFile = join(mkTempDir(), 'body.md');
    writeFileSync(bodyFile, 'from a file\n');

    expect(() => gh.createMr({ source: 'a', target: 'b', title: 't', body: 'x', bodyFile })).toThrow(
      /alternatives/,
    );
    expect(() => gh.createMr({ source: '', target: 'b', title: 't' })).toThrow(/source and target/);
    expect(() => gh.createMr({ source: 'a', target: 'b', title: '' })).toThrow(/title/);

    nextResult = { code: 0, stdout: 'https://github.com/o/r/pull/1', stderr: '' };
    gh.createMr({ source: 'a', target: 'b', title: 't', bodyFile });
    expect(calls.at(-1)?.args).toContain('from a file\n');
  });

  it('says so plainly when the host printed no URL', () => {
    configure({ kind: 'github' });
    nextResult = { code: 0, stdout: 'nothing useful', stderr: '' };
    expect(() => host().createMr({ source: 'a', target: 'b', title: 't' })).toThrow(
      /did not print a merge request URL/,
    );
  });
});

describe('mergeMr', () => {
  it('maps the strategy and leaves the source branch alone by default', () => {
    configure({ kind: 'github' });
    host().mergeMr({ mr: 'https://github.com/o/r/pull/1' });
    expect(calls[0]?.args).toEqual(['pr', 'merge', 'https://github.com/o/r/pull/1', '--merge']);
    // `yan shift done` returns the tree and then deletes the
    // remote branch, so a host that deleted it during the merge would take that
    // step away.
    expect(calls[0]?.args).not.toContain('--delete-branch');
  });

  it('turns glab --auto-merge off', () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    host().mergeMr({ mr: '7', repo: 'o/r', strategy: 'squash', deleteSource: true });
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

  it('refuses a strategy that is not one of the three', () => {
    configure({ kind: 'github' });
    expect(() => host().mergeMr({ mr: '1', strategy: 'ship-it' as unknown as 'merge' })).toThrow(
      /unknown merge strategy/,
    );
  });

  it('throws when the merge did not happen', () => {
    configure({ kind: 'github' });
    nextResult = { code: 1, stdout: '', stderr: 'not mergeable' };
    expect(() => host().mergeMr({ mr: '1' })).toThrow(/could not merge/);
  });
});

describe('reference shaping', () => {
  it('gh takes a URL verbatim and does not also get --repo', () => {
    configure({ kind: 'github' });
    nextResult = { code: 0, stdout: '{}', stderr: '' };
    host().mrState({ mr: 'https://github.com/o/r/pull/1', repo: 'o/r' });
    expect(calls[0]?.args).toEqual([
      'pr',
      'view',
      'https://github.com/o/r/pull/1',
      '--json',
      'state,mergedAt',
    ]);
  });

  it('glab gets an iid and a project split out of the URL', () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    nextResult = { code: 0, stdout: '{}', stderr: '' };
    host().mrState({ mr: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/42?tab=x' });
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

  it('refuses a reference glab could never use', () => {
    configure({ kind: 'gitlab', host: 'gitlab.example.com' });
    expect(() => host().mrState({ mr: 'feat/auth' })).toThrow(
      /cannot work out the merge request number/,
    );
  });
});
