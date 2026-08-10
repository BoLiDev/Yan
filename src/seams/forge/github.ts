import type { CiState, MrState } from './types.js';

/**
 * GitHub's JSON, mapped into yan's vocabulary. Both mappers are PURE: no
 * network, no configuration, no module state. They are the highest-value code
 * in this seam, because a wrong confident answer would come from here, and they
 * are tested against payloads a real `gh` really printed
 * (tests/fixtures/forge/PROVENANCE.json).
 */

function asObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asArray(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * `gh pr view --json state,mergedAt` → yan vocabulary.
 *
 * `mergedAt` (REST: `merged`) is consulted before `state`, and deliberately so:
 * a SQUASH-merged pull request is merged even though its head commit is not an
 * ancestor of the base branch and its branch may already be deleted. Local git
 * ancestry is not the question; what the forge says is (Rule 1).
 */
export function mapMrState(payload: string): MrState {
  const o = asObject(payload);
  if (o === undefined) return 'unknown';
  if (o.mergedAt !== null && o.mergedAt !== undefined) return 'merged';
  if (o.merged === true) return 'merged';
  switch (lower(o.state)) {
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed';
    case 'open':
      return 'open';
    default:
      return 'unknown';
  }
}

/**
 * `gh pr view --json statusCheckRollup` → yan vocabulary.
 *
 * The rollup is where GitHub's two CI systems meet in one array:
 *
 *   CheckRun       (checks API)  status QUEUED|IN_PROGRESS|COMPLETED|…
 *                                conclusion SUCCESS|FAILURE|SKIPPED|…
 *   StatusContext  (legacy)      state EXPECTED|PENDING|SUCCESS|FAILURE|ERROR
 *
 * Both are collapsed to one word per entry and then folded with a fixed
 * precedence: RED BEATS PENDING BEATS GREEN. A failure is a settled fact and
 * the caller can act on it now; waiting for the rest of a run that has already
 * failed only delays the fix.
 *
 * Per-entry rules:
 *   green    success, neutral, skipped — nothing is blocking
 *   pending  not finished yet, or a conclusion of `stale` (GitHub supersedes
 *            those, so they are neither a pass nor a failure)
 *   red      failure, timed_out, cancelled, action_required, startup_failure,
 *            and anything else terminal we do not recognise
 *
 * An empty rollup is `none`: this repository ran no CI for this MR. A payload
 * with no rollup key at all is NOT `none` — that would be a confident wrong
 * answer — it is `pending`.
 */
export function mapCiState(payload: string): CiState {
  let rollup: unknown[] | undefined;

  const array = asArray(payload);
  if (array !== undefined) {
    rollup = array;
  } else {
    const o = asObject(payload);
    if (o === undefined) return 'pending';
    if (!Object.hasOwn(o, 'statusCheckRollup')) return 'pending';
    const value = o.statusCheckRollup;
    // gh prints null for a pull request with no checks at all.
    if (value === null) return 'none';
    if (!Array.isArray(value)) return 'pending';
    rollup = value;
  }

  if (rollup.length === 0) return 'none';

  const words = rollup.map((raw): CiState => {
    const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const isStatusContext =
      entry.__typename === 'StatusContext' ||
      (Object.hasOwn(entry, 'state') && !Object.hasOwn(entry, 'status'));

    if (isStatusContext) {
      const s = lower(entry.state);
      if (s === 'success') return 'green';
      if (s === 'failure' || s === 'error') return 'red';
      return 'pending';
    }

    if (lower(entry.status) !== 'completed') return 'pending';
    const c = lower(entry.conclusion);
    if (c === 'success' || c === 'neutral' || c === 'skipped') return 'green';
    if (c === '' || c === 'stale') return 'pending';
    return 'red';
  });

  if (words.includes('red')) return 'red';
  if (words.includes('pending')) return 'pending';
  return 'green';
}

/**
 * `gh` takes a number, a URL or a branch verbatim. A URL already names the
 * repository, so `--repo` would only be a chance to disagree with it.
 */
export function refArgs(mr: string, repo: string | undefined): string[] {
  const args = [mr];
  if (!/^https?:\/\//.test(mr) && repo !== undefined && repo !== '') {
    args.push('--repo', repo);
  }
  return args;
}
