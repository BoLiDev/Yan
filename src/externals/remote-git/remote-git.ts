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
 * The remote git host — GitHub or GitLab (see
 * §4.3).
 *
 * Everything that opens, queries or merges a merge request, and everything that
 * asks about CI, goes through here. Callers speak yan's vocabulary only. They
 * never learn which host the repository lives on.
 *
 *     createMr   open one, return its URL
 *     mrState    merged | closed | open | unknown
 *     mergeMr    merge it, now
 *     ciState    green | red | pending | none
 *
 * Four verbs over a thick implementation. The five differences between the two
 * CLIs — argument shapes, terminology, JSON shapes, authentication, and the CI
 * model itself — all live behind `Provider`, resolved once in the constructor.
 * There is no `if (kind === 'github')` in this file.
 *
 * The failure mode to guard against is this degrading into a shallow module —
 * one-line pass-throughs, the outside tool's own words leaking out, and the
 * caller still having to know which system it is talking to. The defence is
 * that the interface is written in yan's vocabulary, and that every verb
 * declares the options it takes and refuses everything else, so a caller cannot
 * smuggle `--admin` or `--auto-merge` through.
 *
 * Exit behaviour: the two query verbs always return a member of their closed
 * set, including when the host cannot be reached — that is reported as
 * `unknown` / `pending` plus a note on stderr, so a caller branches on the
 * value and never has to catch. The two action verbs throw a `RemoteGitError` when
 * they did not work.
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
   * Open a merge request and return its URL. That URL is the reference the
   * other three verbs take, and the value a unit stores as
   * `unit.mr`.
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

  /** Exactly one of: merged | closed | open | unknown. */
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
   * Merge now. `deleteSource` is off by default on purpose:
   * fixes the order of `yan shift done` as return the tree, then delete the
   * remote branch, and a host that deleted it during the merge would take that
   * step away.
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
   * Exactly one of: green | red | pending | none.
   *
   * It does not say which job failed. That is not withheld to be tidy: the two
   * hosts' job identities do not line up, and inventing a common shape for them
   * would throw information away. `red` is the fact; reading the details is the
   * shift's job.
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
 * Which CLI this machine's configuration names.
 *
 * A module function rather than a method because bootstrap has to answer it
 * before there is anything to construct — and it has to check exactly one CLI,
 * since checking both would report a failure on a perfectly healthy machine.
 */
export function configuredCli(kind?: HostKind): 'gh' | 'glab' {
  return (kind ?? readConfig().kind) === 'github' ? 'gh' : 'glab';
}
