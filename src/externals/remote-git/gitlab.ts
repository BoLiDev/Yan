import type { ProcessResult } from '../../util/process.js';
import type { Provider } from './provider.js';
import type { MergeStrategy, MrCreateOptions, MrState } from './types.js';
import { asObject, extractUrl, lower } from './validate.js';
import { YanError } from '../../util/error.js';

/**
 * GitLab's JSON, mapped into yan's vocabulary. The mapper is pure, and
 * anything unrecognised lands on the safe member of the set.
 */

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
 * `glab`'s way of naming one merge request: an iid, plus the project parsed
 * out of a URL.
 *
 * @throws YanError `remote_git_usage` when no number can be worked out.
 */
export function refArgs(mr: string): string[] {
  let iid = mr;
  let project = '';

  if (/^https?:\/\//.test(mr)) {
    iid = mr.slice(mr.lastIndexOf('/merge_requests/') + '/merge_requests/'.length);
    iid = iid.split('/')[0] ?? '';
    iid = iid.split('?')[0] ?? '';
    iid = iid.split('#')[0] ?? '';

    let rest = mr.includes('/-/merge_requests/')
      ? mr.slice(0, mr.indexOf('/-/merge_requests/'))
      : mr.slice(0, mr.indexOf('/merge_requests/'));
    rest = rest.replace(/^[a-z]+:\/\//, '');
    project = rest.slice(rest.indexOf('/') + 1);
  }

  if (iid === '' || !/^[0-9]+$/.test(iid)) {
    throw new YanError('remote_git_usage', `cannot work out the merge request number from '${mr}' - pass a number or a full merge request URL`,
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
    return args;
  },

  /** Searches both streams: glab picks one by version. */
  createdUrl(result: ProcessResult): string {
    return extractUrl(
      `${result.stdout}${result.stderr}`,
      /https?:\/\/\S+\/merge_requests\/[0-9]+/g,
    );
  },

  stateArgs(mr) {
    return ['mr', 'view', ...refArgs(mr), '--output', 'json'];
  },

  /**
   * Carries `--auto-merge=false`, which glab otherwise defaults to true —
   * scheduling the merge behind a pipeline and reporting success.
   */
  mergeArgs(mr: string, strategy: MergeStrategy) {
    const args = ['mr', 'merge', ...refArgs(mr), '--yes', '--auto-merge=false'];
    if (strategy === 'squash') args.push('--squash');
    if (strategy === 'rebase') args.push('--rebase');
    return args;
  },

  closeArgs(mr: string) {
    return ['mr', 'close', ...refArgs(mr)];
  },

  mapMrState,
};
