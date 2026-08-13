import type { CliResult } from './client.js';
import { RemoteGitError } from './errors.js';
import type { Provider } from './provider.js';
import type { CiState, MergeStrategy, MrCreateOptions, MrState } from './types.js';
import { extractUrl } from './validate.js';

/**
 * GitLab's JSON, mapped into yan's vocabulary. Both mappers are pure, and
 * anything unrecognised lands on the safe member of the set.
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

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * `glab mr view --output json` → yan vocabulary. `locked` reads as `open`, and
 * anything unrecognised as `unknown`.
 */
export function mapMrState(payload: string): MrState {
  const o = asObject(payload);
  if (o === undefined) return 'unknown';
  if (o.merged_at !== null && o.merged_at !== undefined) return 'merged';
  switch (lower(o.state)) {
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed';
    case 'opened':
    case 'locked':
      return 'open';
    default:
      return 'unknown';
  }
}

/**
 * The MR payload's `head_pipeline` (older GitLab: `pipeline`) → yan
 * vocabulary.
 *
 *   green    success
 *   red      failed, canceled — a cancelled pipeline did not pass
 *   pending  created, waiting_for_resource, preparing, pending, running,
 *            manual (waiting for a human to press play), scheduled, canceling
 *   none     no pipeline at all, or a skipped one: nothing ran
 */
export function mapCiState(payload: string): CiState {
  const o = asObject(payload);
  if (o === undefined) return 'pending';

  const raw = o.head_pipeline ?? o.pipeline ?? null;
  if (raw === null) return 'none';
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'pending';

  switch (lower((raw as Record<string, unknown>).status)) {
    case 'success':
      return 'green';
    case 'failed':
    case 'canceled':
    case 'cancelled':
      return 'red';
    case 'skipped':
      return 'none';
    default:
      return 'pending';
  }
}

/**
 * `glab`'s way of naming one merge request: an iid, plus the project taken
 * from `repo` or parsed out of a URL.
 *
 * @throws RemoteGitError `usage` when no number can be worked out.
 */
export function refArgs(mr: string, repo: string | undefined): string[] {
  let iid = mr;
  let project = repo ?? '';

  if (/^https?:\/\//.test(mr)) {
    iid = mr.slice(mr.lastIndexOf('/merge_requests/') + '/merge_requests/'.length);
    iid = iid.split('/')[0] ?? '';
    iid = iid.split('?')[0] ?? '';
    iid = iid.split('#')[0] ?? '';

    if (project === '') {
      let rest = mr.includes('/-/merge_requests/')
        ? mr.slice(0, mr.indexOf('/-/merge_requests/'))
        : mr.slice(0, mr.indexOf('/merge_requests/'));
      rest = rest.replace(/^[a-z]+:\/\//, '');
      project = rest.slice(rest.indexOf('/') + 1);
    }
  }

  if (iid === '' || !/^[0-9]+$/.test(iid)) {
    throw new RemoteGitError('usage', `cannot work out the merge request number from '${mr}' - pass a number or a full merge request URL`,
      { exitCode: 2 },
    );
  }

  const args = [iid];
  if (project !== '') args.push('--repo', project);
  return args;
}

export const gitlabProvider: Provider = {
  cli: 'glab',

  /** Carries `--no-editor --yes`, so glab never opens an editor and waits. */
  createArgs(options: MrCreateOptions, body: string): string[] {
    const args = [
      'mr',
      'create',
      '--source-branch',
      options.source,
      '--target-branch',
      options.target,
      '--title',
      options.title,
      '--description',
      body,
      '--no-editor',
      '--yes',
    ];
    if (options.draft === true) args.push('--draft');
    if (options.repo !== undefined && options.repo !== '') args.push('--repo', options.repo);
    return args;
  },

  /** Searches both streams: glab picks one by version. */
  createdUrl(result: CliResult): string {
    return extractUrl(
      `${result.stdout}${result.stderr}`,
      /https?:\/\/\S+\/merge_requests\/[0-9]+/g,
    );
  },

  stateArgs(mr, repo) {
    return ['mr', 'view', ...refArgs(mr, repo), '--output', 'json'];
  },

  ciArgs(mr, repo) {
    return ['mr', 'view', ...refArgs(mr, repo), '--output', 'json'];
  },

  /**
   * Carries `--auto-merge=false`, which glab otherwise defaults to true —
   * scheduling the merge behind a pipeline and reporting success.
   */
  mergeArgs(mr: string, repo: string | undefined, strategy: MergeStrategy, deleteSource: boolean) {
    const args = ['mr', 'merge', ...refArgs(mr, repo), '--yes', '--auto-merge=false'];
    if (strategy === 'squash') args.push('--squash');
    if (strategy === 'rebase') args.push('--rebase');
    if (deleteSource) args.push('--remove-source-branch');
    return args;
  },

  mapMrState,
  mapCiState,
};
