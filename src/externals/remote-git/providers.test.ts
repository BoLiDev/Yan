import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as github from './github.js';
import * as gitlab from './gitlab.js';
import { CI_STATES, MR_STATES, gateCiState, gateMrState } from './types.js';
import type { CiState, MrState } from './types.js';
import { repoRoot } from '../../../tests/helpers/fixtures.js';

/**
 * The port of `tests/unit/lib-forge-map.test.sh`.
 *
 * Phase 2 Trace: "forge_mr_state ∈ {merged, closed, open, unknown};
 * forge_ci_state ∈ {green, red, pending, none}" and "every fixture under
 * tests/fixtures/forge/ replays to the same verdict as the bash
 * implementation".
 *
 * These are the highest-value tests in the phase. The mapping from a forge's
 * raw JSON to yan's vocabulary is where a wrong confident answer would come
 * from, so every case below is driven by a payload that a real CLI really
 * printed (GitHub) or by a shape taken from the published API documentation
 * (GitLab — tests/fixtures/forge/PROVENANCE.json is explicit about which is
 * which). The fixtures are ported as-is; no network.
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
    // cli/cli#14103 was SQUASH-merged: its head commit is not an ancestor of
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

describe('GitHub: CI', () => {
  it('maps the checks API', () => {
    expect(github.mapCiState(fx('github/ci-none.json'))).toBe('none');
    expect(github.mapCiState(fx('github/ci-checks-green.json'))).toBe('green');
    expect(github.mapCiState(fx('github/ci-checks-mixed-red.json'))).toBe('red');
    expect(github.mapCiState(fx('github/ci-checks-running.json'))).toBe('pending');
  });

  it('maps the legacy commit-status API, in the same array', () => {
    expect(github.mapCiState(fx('github/ci-status-green.json'))).toBe('green');
    expect(github.mapCiState(fx('github/ci-status-pending.json'))).toBe('pending');
    expect(github.mapCiState(fx('github/ci-status-red.json'))).toBe('red');
  });

  it('lets red beat pending', () => {
    // A run that is still going but has already failed is red. The caller can
    // dispatch the fix now; waiting for the rest only delays it.
    expect(github.mapCiState(fx('github/ci-red-beats-pending.json'))).toBe('red');
  });

  it('tells "no checks" from "no answer"', () => {
    expect(github.mapCiState('{"statusCheckRollup":null}')).toBe('none');
    // A payload with no rollup at all is not none - that would be a confident
    // wrong answer.
    expect(github.mapCiState('{}')).toBe('pending');
    expect(github.mapCiState('')).toBe('pending');
    expect(github.mapCiState('GraphQL: Could not resolve to a PullRequest')).toBe('pending');
  });

  it('classifies each conclusion the way the comment says', () => {
    const rollup = (...entries: string[]): string =>
      `{"statusCheckRollup":[${entries.join(',')}]}`;
    const run = (status: string, conclusion: string): string =>
      `{"__typename":"CheckRun","status":"${status}","conclusion":"${conclusion}"}`;

    expect(github.mapCiState(rollup(run('COMPLETED', 'NEUTRAL'), run('COMPLETED', 'SKIPPED')))).toBe(
      'green',
    );
    expect(github.mapCiState(rollup(run('COMPLETED', 'TIMED_OUT')))).toBe('red');
    expect(github.mapCiState(rollup(run('COMPLETED', 'CANCELLED')))).toBe('red');
    // A superseded check is neither a pass nor a failure.
    expect(github.mapCiState(rollup(run('COMPLETED', 'STALE')))).toBe('pending');
    expect(github.mapCiState(rollup(run('QUEUED', '')))).toBe('pending');
  });
});

describe('GitLab: merge request state', () => {
  it('maps the four states onto yan\'s three plus unknown', () => {
    expect(gitlab.mapMrState(fx('gitlab/mr-merged.json'))).toBe('merged');
    // GitLab says opened; yan says open.
    expect(gitlab.mapMrState(fx('gitlab/mr-opened.json'))).toBe('open');
    expect(gitlab.mapMrState(fx('gitlab/mr-closed.json'))).toBe('closed');
    // GitLab's fourth state, locked, collapses onto open - §6.4 gets four
    // values, not five.
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

describe('GitLab: CI', () => {
  it('maps one pipeline, one status', () => {
    expect(gitlab.mapCiState(fx('gitlab/mr-merged.json'))).toBe('green');
    expect(gitlab.mapCiState(fx('gitlab/mr-opened.json'))).toBe('pending');
    // manual means it is waiting for a human, which is pending.
    expect(gitlab.mapCiState(fx('gitlab/mr-locked.json'))).toBe('pending');
    expect(gitlab.mapCiState(fx('gitlab/ci-failed.json'))).toBe('red');
    // A cancelled pipeline did not pass.
    expect(gitlab.mapCiState(fx('gitlab/ci-canceled.json'))).toBe('red');
    // Skipped means nothing ran.
    expect(gitlab.mapCiState(fx('gitlab/ci-skipped.json'))).toBe('none');
    expect(gitlab.mapCiState(fx('gitlab/ci-pending-created.json'))).toBe('pending');
    expect(gitlab.mapCiState(fx('gitlab/ci-no-pipeline.json'))).toBe('none');
    // Older GitLab exposes `pipeline` rather than `head_pipeline`.
    expect(gitlab.mapCiState(fx('gitlab/ci-legacy-pipeline-field.json'))).toBe('green');
  });

  it('falls back to pending for anything it does not recognise', () => {
    expect(gitlab.mapCiState('')).toBe('pending');
    expect(gitlab.mapCiState('{"head_pipeline":{"status":"canceling"}}')).toBe('pending');
    expect(gitlab.mapCiState('{"head_pipeline":{"status":"who_knows"}}')).toBe('pending');
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
    for (const v of [github.mapCiState(body), gitlab.mapCiState(body)]) {
      expect(CI_STATES).toContain(v);
    }
  });
});

/**
 * The verdict every fixture produced, all four mappers, frozen.
 *
 * Phase 2's Trace bullet was "every fixture replays to the same verdict as the
 * bash implementation", and until Phase 9 this block proved it the literal way:
 * source `bin/lib-forge.sh`, run its four mappers over the same files, compare.
 * That is what let two implementations of 861 lines of JSON mapping live side by
 * side without drifting.
 *
 * Phase 9 deleted the bash half, so the comparison has no second side left. The
 * ASSERTION IS KEPT ANYWAY, with the reference frozen rather than re-derived:
 * this table is the exact output of that script on its last run, and it is the
 * only place the every-fixture-times-four-mappers guarantee lives. The named
 * tests above are spot checks with reasons; this is the sweep.
 *
 * A row that has to change is a behaviour change, and should be argued for in
 * the commit that changes it — which is the same thing the bash comparison
 * demanded, minus the bash.
 */
const RECORDED: readonly [string, MrState, CiState, MrState, CiState][] = [
  ['github/ci-checks-green.json', 'unknown', 'green', 'unknown', 'none'],
  ['github/ci-checks-mixed-red.json', 'unknown', 'red', 'unknown', 'none'],
  ['github/ci-checks-running.json', 'unknown', 'pending', 'unknown', 'none'],
  ['github/ci-none.json', 'unknown', 'none', 'unknown', 'none'],
  ['github/ci-red-beats-pending.json', 'unknown', 'red', 'unknown', 'none'],
  ['github/ci-status-green.json', 'unknown', 'green', 'unknown', 'none'],
  ['github/ci-status-pending.json', 'unknown', 'pending', 'unknown', 'none'],
  ['github/ci-status-red.json', 'unknown', 'red', 'unknown', 'none'],
  ['github/mr-closed-unmerged.json', 'closed', 'pending', 'closed', 'none'],
  ['github/mr-merged-mergecommit.json', 'merged', 'pending', 'merged', 'none'],
  ['github/mr-merged-squash-branch-deleted.json', 'merged', 'pending', 'merged', 'none'],
  ['github/mr-open.json', 'open', 'pending', 'unknown', 'none'],
  ['gitlab/ci-canceled.json', 'unknown', 'pending', 'open', 'red'],
  ['gitlab/ci-failed.json', 'unknown', 'pending', 'open', 'red'],
  ['gitlab/ci-legacy-pipeline-field.json', 'unknown', 'pending', 'open', 'green'],
  ['gitlab/ci-no-pipeline.json', 'unknown', 'pending', 'open', 'none'],
  ['gitlab/ci-pending-created.json', 'unknown', 'pending', 'open', 'pending'],
  ['gitlab/ci-skipped.json', 'unknown', 'pending', 'open', 'none'],
  ['gitlab/mr-closed.json', 'closed', 'pending', 'closed', 'none'],
  ['gitlab/mr-locked.json', 'unknown', 'pending', 'open', 'pending'],
  ['gitlab/mr-merged.json', 'merged', 'pending', 'merged', 'green'],
  ['gitlab/mr-opened.json', 'unknown', 'pending', 'open', 'pending'],
  ['gitlab/mr-state-unknown-to-yan.json', 'unknown', 'pending', 'unknown', 'none'],
  ['github/mr-api-error.stderr.txt', 'unknown', 'pending', 'unknown', 'pending'],
  ['github/mr-api-error.stdout.txt', 'unknown', 'pending', 'unknown', 'pending'],
];

describe('every fixture, all four mappers, against the recorded verdicts', () => {
  it('covers every fixture on disk, so the table cannot quietly shrink', () => {
    expect(RECORDED.map((r) => r[0]).sort()).toEqual([...everyFixture()].sort());
  });

  it.each(RECORDED)('%s', (name, ghMr, ghCi, glMr, glCi) => {
    const body = fx(name);
    expect(github.mapMrState(body), `${name} github mr`).toBe(ghMr);
    expect(github.mapCiState(body), `${name} github ci`).toBe(ghCi);
    expect(gitlab.mapMrState(body), `${name} gitlab mr`).toBe(glMr);
    expect(gitlab.mapCiState(body), `${name} gitlab ci`).toBe(glCi);
  });
});

describe('the gates themselves', () => {
  it('are the last statement on every path out', () => {
    expect(gateMrState('banana')).toBe('unknown');
    expect(gateCiState('banana')).toBe('pending');
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
