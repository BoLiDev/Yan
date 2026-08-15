import type { CliResult } from './client.js';
import type { Provider } from './provider.js';
import type { CiState, MergeStrategy, MrCreateOptions, MrState } from './types.js';
import { extractUrl } from './validate.js';

/** GitHub's JSON, mapped into yan's vocabulary. Both mappers are pure. */

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
 * `gh pr view --json state,mergedAt` → yan vocabulary. `mergedAt` (or the REST
 * API's `merged`) wins over `state`, so a squash merge reads as merged.
 * Anything unrecognised is `unknown`.
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
 * `gh pr view --json statusCheckRollup` → yan vocabulary. Handles both entry
 * shapes in the rollup, CheckRun and the legacy StatusContext, and folds them
 * red > pending > green — so a red answer can arrive before the run finishes.
 *
 * Per entry:
 *   green    success, neutral, skipped
 *   pending  not finished yet, or a `stale` conclusion
 *   red      anything else terminal
 *
 * An empty or null rollup is `none`; a payload with no rollup key at all is
 * `pending`, never `none`.
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
 * `gh`'s way of naming one merge request: the ref verbatim, plus `--repo`
 * unless the ref is a URL, which already names the repository.
 */
export function refArgs(mr: string, repo: string | undefined): string[] {
  const args = [mr];
  if (!/^https?:\/\//.test(mr) && repo !== undefined && repo !== '') {
    args.push('--repo', repo);
  }
  return args;
}

export const githubProvider: Provider = {
  cli: 'gh',

  createArgs(options: MrCreateOptions, body: string): string[] {
    const args = [
      'pr',
      'create',
      '--base',
      options.target,
      '--head',
      options.source,
      '--title',
      options.title,
      '--body',
      body,
    ];
    if (options.draft === true) args.push('--draft');
    if (options.repo !== undefined && options.repo !== '') args.push('--repo', options.repo);
    return args;
  },

  createdUrl(result: CliResult): string {
    return extractUrl(result.stdout, /https?:\/\/\S+\/pull\/[0-9]+/g);
  },

  stateArgs(mr, repo) {
    return ['pr', 'view', ...refArgs(mr, repo), '--json', 'state,mergedAt'];
  },

  ciArgs(mr, repo) {
    return ['pr', 'view', ...refArgs(mr, repo), '--json', 'statusCheckRollup'];
  },

  mergeArgs(mr: string, repo: string | undefined, strategy: MergeStrategy, deleteSource: boolean) {
    const args = ['pr', 'merge', ...refArgs(mr, repo), `--${strategy}`];
    if (deleteSource) args.push('--delete-branch');
    return args;
  },

  mapMrState,
  mapCiState,
};
