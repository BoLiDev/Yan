import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as github from './github.js';
import * as gitlab from './gitlab.js';
import { MR_STATES } from './types.js';
import type { MrState } from './types.js';
import { repoRoot } from '../../../tests/helpers/fixtures.js';

/**
 * What is under test: `MrState` is one of {merged, closed, open, unknown}, for
 * every fixture under tests/fixtures/forge/.
 *
 * Every case is driven by a payload a real CLI printed (GitHub) or a shape
 * from the published API documentation (GitLab); PROVENANCE.json says which.
 * No network.
 */

const FX = join(repoRoot, 'tests', 'fixtures', 'forge');

function fx(name: string): string {
  return readFileSync(join(FX, name), 'utf8');
}

function everyFixture(): string[] {
  const files: string[] = [];
  for (const provider of ['github', 'gitlab']) {
    for (const name of readdirSync(join(FX, provider))) {
      if (name.endsWith('.json') || name.endsWith('.txt')) files.push(`${provider}/${name}`);
    }
  }
  return files.sort();
}

describe('GitHub: merge request state', () => {
  it('maps a merge-commit merge', () => {
    expect(github.mapMrState(fx('github/mr-merged-mergecommit.json'))).toBe('merged');
  });

  it('maps the awkward one: squash-merged, branch deleted', () => {
    // cli/cli#14103 was squash-merged: its head commit is not an ancestor of
    // the base branch, and the head branch has since been deleted. Anything
    // that reasoned from local git ancestry would get this wrong (Rule 1).
    expect(github.mapMrState(fx('github/mr-merged-squash-branch-deleted.json'))).toBe('merged');
  });

  it('maps open, and closed-without-merging', () => {
    expect(github.mapMrState(fx('github/mr-open.json'))).toBe('open');
    // Being a draft changes nothing.
    expect(github.mapMrState(fx('github/mr-closed-unmerged.json'))).toBe('closed');
  });

  it('never answers confidently when it was handed nothing usable', () => {
    // What the mapper is actually handed when the API refuses: gh exits
    // non-zero and stdout is empty.
    expect(github.mapMrState(fx('github/mr-api-error.stdout.txt'))).toBe('unknown');
    expect(github.mapMrState(fx('github/mr-api-error.stderr.txt'))).toBe('unknown');
    expect(github.mapMrState('')).toBe('unknown');
    expect(github.mapMrState('not json at all')).toBe('unknown');
    expect(github.mapMrState('[]')).toBe('unknown');
    expect(github.mapMrState('{"state":"SOMETHING_NEW","mergedAt":null}')).toBe('unknown');
  });

  it('understands the REST spelling too', () => {
    expect(github.mapMrState('{"state":"closed","merged":true}')).toBe('merged');
    expect(github.mapMrState('{"state":"closed","merged":false}')).toBe('closed');
  });
});

describe('GitLab: merge request state', () => {
  it('maps the four states onto yan\'s three plus unknown', () => {
    expect(gitlab.mapMrState(fx('gitlab/mr-merged.json'))).toBe('merged');
    // GitLab says opened; yan says open.
    expect(gitlab.mapMrState(fx('gitlab/mr-opened.json'))).toBe('open');
    expect(gitlab.mapMrState(fx('gitlab/mr-closed.json'))).toBe('closed');
    // GitLab's fourth state collapses onto open: yan has four, not five.
    expect(gitlab.mapMrState(fx('gitlab/mr-locked.json'))).toBe('open');
    expect(gitlab.mapMrState(fx('gitlab/mr-state-unknown-to-yan.json'))).toBe('unknown');
  });

  it('lets merged_at settle it even when state disagrees', () => {
    expect(
      gitlab.mapMrState('{"state":"opened","merged_at":"2026-05-14T03:38:31.354Z"}'),
    ).toBe('merged');
  });

  it('never answers confidently when it was handed nothing usable', () => {
    expect(gitlab.mapMrState('')).toBe('unknown');
    expect(gitlab.mapMrState('error: 404 Not Found')).toBe('unknown');
  });
});

describe('every fixture lands inside the closed set', () => {
  // Not a spot check: run the lot through both providers' mappers and refuse
  // anything that is not a member.
  it.each(everyFixture())('%s', (name) => {
    const body = fx(name);
    for (const v of [github.mapMrState(body), gitlab.mapMrState(body)]) {
      expect(MR_STATES).toContain(v);
    }
  });
});

/**
 * The verdict every fixture produced, both mappers, frozen.
 *
 * Frozen rather than re-derived, so a changed mapping shows up as a diff here
 * rather than as a quietly different verdict. A row that has to change is a
 * behaviour change.
 */
const RECORDED: readonly [string, MrState, MrState][] = [
  ['github/mr-closed-unmerged.json', 'closed', 'closed'],
  ['github/mr-merged-mergecommit.json', 'merged', 'merged'],
  ['github/mr-merged-squash-branch-deleted.json', 'merged', 'merged'],
  ['github/mr-open.json', 'open', 'unknown'],
  ['gitlab/mr-closed.json', 'closed', 'closed'],
  ['gitlab/mr-locked.json', 'unknown', 'open'],
  ['gitlab/mr-merged.json', 'merged', 'merged'],
  ['gitlab/mr-opened.json', 'unknown', 'open'],
  ['gitlab/mr-state-unknown-to-yan.json', 'unknown', 'unknown'],
  ['github/mr-api-error.stderr.txt', 'unknown', 'unknown'],
  ['github/mr-api-error.stdout.txt', 'unknown', 'unknown'],
];

describe('every fixture, both mappers, against the recorded verdicts', () => {
  it('covers every fixture on disk, so the table cannot quietly shrink', () => {
    expect(RECORDED.map((r) => r[0]).sort()).toEqual([...everyFixture()].sort());
  });

  it.each(RECORDED)('%s', (name, ghMr, glMr) => {
    const body = fx(name);
    expect(github.mapMrState(body), `${name} github mr`).toBe(ghMr);
    expect(gitlab.mapMrState(body), `${name} gitlab mr`).toBe(glMr);
  });
});

describe('provenance is complete and honest', () => {
  // A fixture with no provenance entry is a fixture nobody can trust later.
  const provenance = JSON.parse(readFileSync(join(FX, 'PROVENANCE.json'), 'utf8')) as {
    files: Record<string, { verified: boolean }>;
  };

  it.each(everyFixture())('%s has an entry that says where it came from', (name) => {
    const entry = provenance.files[name];
    expect(entry, `${name} has no entry in PROVENANCE.json`).toBeDefined();
    // GitHub fixtures came off the wire and must say so; GitLab fixtures are
    // documentation-derived and must not claim otherwise.
    expect(entry?.verified).toBe(name.startsWith('github/'));
  });
});
