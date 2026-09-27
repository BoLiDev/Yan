import type { ProcessResult } from '../../util/process.js';
import type { Provider } from './provider.js';
import type { MergeStrategy, MrCreateOptions, MrState } from './types.js';
import { asObject, extractUrl, lower } from './reply.js';

/** GitHub's JSON, mapped into yan's vocabulary. The mapper is pure. */

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
    return args;
  },

  createdUrl(result: ProcessResult): string {
    return extractUrl(result.stdout, /https?:\/\/\S+\/pull\/[0-9]+/g);
  },

  /** `gh` takes the ref verbatim: a URL names its repository, a number the clone's. */
  stateArgs(mr) {
    return ['pr', 'view', mr, '--json', 'state,mergedAt'];
  },

  mergeArgs(mr: string, strategy: MergeStrategy) {
    return ['pr', 'merge', mr, `--${strategy}`];
  },

  closeArgs(mr: string) {
    return ['pr', 'close', mr];
  },

  mapMrState,
};
