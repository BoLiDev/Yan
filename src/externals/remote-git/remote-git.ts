import { runCli, type CliInvocation, type CliResult } from './client.js';
import { hostFor, readConfig } from './config.js';
import { RemoteGitError } from './errors.js';
import { githubProvider } from './github.js';
import { gitlabProvider } from './gitlab.js';
import type { Provider } from './provider.js';
import {
  gateCiState,
  gateMrState,
  type CiState,
  type HostKind,
  type MrCreateOptions,
  type MrMergeOptions,
  type MrRef,
  type MrState,
} from './types.js';
import { bodyText, checkDir, only, requireMr, unreachable } from './validate.js';

/** How a CLI is actually run. Replaceable so a test needs no module mocking. */
export type CliRunner = (invocation: CliInvocation) => CliResult;

export interface RemoteGitOptions {
  /** Defaults to the real `gh` / `glab`. */
  readonly run?: CliRunner;
}

/**
 * The remote git host — GitHub or GitLab — behind four verbs:
 *
 *     createMr   open one, return its URL
 *     mrState    merged | closed | open | unknown
 *     mergeMr    merge it, now
 *     ciState    green | red | pending | none
 *
 * Which host is resolved once, in the constructor, and never reaches a caller.
 * Each verb declares the options it takes and throws on any other, so no extra
 * CLI flag can be smuggled through.
 *
 * The two query verbs always return a member of their closed set — a host that
 * cannot be reached is `unknown` / `pending` plus a note on stderr — so a
 * caller branches on the value rather than catching. The two action verbs
 * throw a RemoteGitError when they did not work.
 */
export class RemoteGit {
  private readonly provider: Provider;
  private readonly host: string | undefined;
  private readonly run: CliRunner;

  public constructor(options: RemoteGitOptions = {}) {
    const config = readConfig();
    this.provider = config.kind === 'github' ? githubProvider : gitlabProvider;
    this.host = hostFor(config);
    this.run = options.run ?? runCli;
  }

  /**
   * Open a merge request and return its URL, which is what the other three
   * verbs take as `mr`.
   *
   * @throws RemoteGitError `usage` for a missing or unknown option, `failed`
   *   when the host refused.
   */
  public createMr(options: MrCreateOptions): string {
    only(options, ['repo', 'dir', 'source', 'target', 'title', 'body', 'bodyFile', 'draft']);
    const cwd = checkDir(options);
    if (!options.source || !options.target) {
      throw RemoteGitError.usage('source and target are both required - a merge request always says where it comes from and where it goes',
      );
    }
    if (!options.title) throw RemoteGitError.usage('title is required');

    const result = this.invoke(this.provider.createArgs(options, bodyText(options)), cwd);
    if (result.code !== 0) {
      throw new RemoteGitError('failed', `could not open the merge request - ${result.stderr.trim().replace(/\n/g, ' ')}`,
      );
    }
    return this.provider.createdUrl(result);
  }

  /**
   * Exactly one of: merged | closed | open | unknown. A host that cannot be
   * reached is `unknown` with a note on stderr, never a throw.
   */
  public mrState(ref: MrRef): MrState {
    only(ref, ['repo', 'dir', 'mr']);
    const mr = requireMr(ref);
    const result = this.invoke(this.provider.stateArgs(mr, ref.repo), checkDir(ref));
    if (result.code !== 0) {
      unreachable(mr, 'unknown', result);
      return gateMrState('unknown');
    }
    return gateMrState(this.provider.mapMrState(result.stdout));
  }

  /**
   * Merge now, with `strategy` defaulting to `merge`. The source branch
   * survives unless `deleteSource` says otherwise.
   *
   * @throws RemoteGitError `usage` for an unknown option or strategy, `failed`
   *   when the merge did not happen.
   */
  public mergeMr(options: MrMergeOptions): void {
    only(options, ['repo', 'dir', 'mr', 'strategy', 'deleteSource']);
    const mr = requireMr(options);
    const strategy = options.strategy ?? 'merge';
    if (!['merge', 'squash', 'rebase'].includes(strategy)) {
      throw RemoteGitError.usage(`unknown merge strategy '${strategy}' - use merge, squash or rebase`,
      );
    }

    const args = this.provider.mergeArgs(mr, options.repo, strategy, options.deleteSource === true);
    const result = this.invoke(args, checkDir(options));
    if (result.code !== 0) {
      throw new RemoteGitError('failed', `could not merge ${mr} - ${result.stderr.trim().replace(/\n/g, ' ')}`,
      );
    }
  }

  /**
   * Exactly one of: green | red | pending | none, and never which job failed.
   * A host that cannot be reached is `pending` with a note on stderr.
   */
  public ciState(ref: MrRef): CiState {
    only(ref, ['repo', 'dir', 'mr']);
    const mr = requireMr(ref);
    const result = this.invoke(this.provider.ciArgs(mr, ref.repo), checkDir(ref));
    if (result.code !== 0) {
      unreachable(`CI for ${mr}`, 'pending', result);
      return gateCiState('pending');
    }
    return gateCiState(this.provider.mapCiState(result.stdout));
  }

  private invoke(args: readonly string[], cwd: string | undefined): CliResult {
    return this.run({ cli: this.provider.cli, args, cwd, host: this.host });
  }
}

/**
 * Which CLI the configuration names, answerable without constructing a
 * `RemoteGit`.
 */
export function configuredCli(kind?: HostKind): 'gh' | 'glab' {
  return (kind ?? readConfig().kind) === 'github' ? 'gh' : 'glab';
}
