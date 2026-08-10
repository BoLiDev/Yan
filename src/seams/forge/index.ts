import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { YanError, usageError } from '../../util/error.js';
import { yanHome } from '../../util/home.js';
import { runForgeCli, type ForgeResult } from './client.js';
import * as github from './github.js';
import * as gitlab from './gitlab.js';
import {
  FORGE_CONFIG,
  FORGE_FAILED,
  FORGE_USAGE,
  gateCiState,
  gateMrState,
  type CiState,
  type ForgeKind,
  type MrCreateOptions,
  type MrMergeOptions,
  type MrRef,
  type MrState,
  type RepoRef,
} from './types.js';

/**
 * The remote git seam (delivery.md §8.4, architecture.md §4.3).
 *
 * Everything that opens, queries or merges an MR, and everything that asks
 * about CI, goes through here. Callers speak forge vocabulary only. They never
 * learn whether the repository lives on GitHub or on GitLab.
 *
 *     forgeMrCreate   open an MR/PR, return its URL
 *     forgeMrState    merged | closed | open | unknown
 *     forgeMrMerge    merge it
 *     forgeCiState    green | red | pending | none
 *
 * Four verbs over a thick implementation. Underneath they hide five differences
 * between the two CLIs: argument shapes (including glab's `--auto-merge`
 * default of TRUE, which would silently turn "merge it" into "merge it later"),
 * terminology, JSON shapes, authentication, and the CI model itself — GitLab
 * has one pipeline with one status; GitHub has N check runs PLUS the legacy
 * commit-status API, mixed together in one rollup array.
 *
 * The failure mode to guard against is this seam degrading into a shallow
 * module — one-line pass-throughs, the outside tool's own words leaking out,
 * and the caller still having to know which system it is talking to. The
 * defence is that the interface is written in yan's vocabulary, and that every
 * verb declares the options it takes and REFUSES everything else, so a caller
 * cannot smuggle `--admin` or `--auto-merge` through.
 *
 * Three seam rules from architecture.md §4.3 hold here:
 *   - seams never call other seams (this one uses util/ only — no terminal,
 *     no pool, no hook; the lint rule in scripts/ enforces it);
 *   - seams report facts and decide nothing. `red` is a fact; "red means
 *     dispatch a shift" is the subcommand's business;
 *   - seams never write bookkeeping under $YAN_HOME.
 *
 * Exit behaviour: the two QUERY verbs always return a member of their closed
 * set, including when the forge cannot be reached — that is reported as
 * `unknown` / `pending` plus a note on stderr, so a caller branches on the
 * value and never has to catch. The two ACTION verbs throw a `YanError` when
 * they did not work.
 *
 * Configuration: this module is the ONLY reader of conf/config.json's `forge`
 * section. Subcommands never branch on `forge.kind`.
 */

export type { CiState, ForgeKind, MrState } from './types.js';
export { CI_STATES, MR_STATES } from './types.js';

// --- configuration ---------------------------------------------------------

interface ForgeConfig {
  readonly kind: ForgeKind;
  readonly host: string;
}

function configPath(): string {
  return join(yanHome(), 'conf', 'config.json');
}

function readConfig(): ForgeConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw usageError(
      FORGE_CONFIG,
      `no configuration at ${path} - copy conf/config.sample.json there and set forge.kind`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw usageError(FORGE_CONFIG, `cannot read ${path} - it is not valid JSON; run 'yan doctor'`);
  }
  const forge = (
    typeof parsed === 'object' && parsed !== null
      ? ((parsed as Record<string, unknown>).forge ?? {})
      : {}
  ) as Record<string, unknown>;

  const kind = typeof forge.kind === 'string' ? forge.kind : '';
  if (kind === '') {
    throw usageError(
      FORGE_CONFIG,
      `forge.kind is not set in ${path} - set it to github or gitlab, then run 'yan doctor'`,
    );
  }
  if (kind !== 'github' && kind !== 'gitlab') {
    throw usageError(
      FORGE_CONFIG,
      `forge.kind is '${kind}', which yan does not support - use github or gitlab`,
    );
  }

  const host = typeof forge.host === 'string' ? forge.host : '';
  if (kind === 'gitlab' && host === '') {
    throw usageError(
      FORGE_CONFIG,
      `forge.host is required when forge.kind is gitlab - set it in ${path} (hostname, no scheme), then run 'yan doctor'`,
    );
  }
  return { kind, host };
}

/**
 * Which CLI this machine's configuration names. Exported because bootstrap has
 * to be able to check exactly one CLI — the one `forge.kind` selects — and
 * checking both would report a failure on a perfectly healthy machine.
 */
export function forgeCli(kind?: ForgeKind): 'gh' | 'glab' {
  return (kind ?? readConfig().kind) === 'github' ? 'gh' : 'glab';
}

/** github.com needs no GH_HOST; anything else does. */
function hostFor(config: ForgeConfig): string | undefined {
  if (config.kind === 'github') {
    return config.host === '' || config.host === 'github.com' ? undefined : config.host;
  }
  return config.host;
}

// --- the caller's vocabulary ----------------------------------------------

/**
 * Yan's own options. No `gh` or `glab` flag is ever accepted: every verb
 * declares the option names it takes and this refuses everything else, so a
 * caller cannot reach the provider's surface even by accident. The compiler
 * says the same thing; this is the runtime half, for a caller that arrived
 * through JSON or through `unknown`.
 */
function only(input: object, allowed: readonly string[]): void {
  const options = input as Record<string, unknown>;
  for (const key of Object.keys(options)) {
    if (options[key] === undefined) continue;
    if (!allowed.includes(key)) {
      throw usageError(
        FORGE_USAGE,
        `'${key}' is not accepted here - forge verbs take yan's own options only, never gh's or glab's`,
      );
    }
  }
}

function checkDir(ref: RepoRef): string | undefined {
  if (ref.dir === undefined || ref.dir === '') return undefined;
  let isDir = false;
  try {
    isDir = statSync(ref.dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw usageError(FORGE_USAGE, `dir is not a directory: ${ref.dir}`);
  return ref.dir;
}

function requireMr(ref: MrRef): string {
  if (ref.mr === undefined || ref.mr === '') {
    throw usageError(
      FORGE_USAGE,
      'mr is required - pass the merge request URL forgeMrCreate returned, or its number',
    );
  }
  // A URL or a branch name that arrived from a JSON file read on Git Bash may
  // carry a carriage return, and it would turn into an unexplainable 404.
  return ref.mr.replace(/\r/g, '');
}

function bodyText(options: MrCreateOptions): string {
  if (options.bodyFile !== undefined && options.bodyFile !== '') {
    if (options.body !== undefined && options.body !== '') {
      throw usageError(FORGE_USAGE, 'body and bodyFile are alternatives - pass one');
    }
    if (!existsSync(options.bodyFile)) {
      throw usageError(FORGE_USAGE, `bodyFile does not exist: ${options.bodyFile}`);
    }
    return readFileSync(options.bodyFile, 'utf8');
  }
  return options.body ?? '';
}

function unreachable(what: string, fallback: string, result: ForgeResult): void {
  const detail = result.stderr.trim().replace(/\n/g, ' ');
  process.stderr.write(
    `lib-forge: cannot ask the forge about ${what} - reporting ${fallback}${detail === '' ? '' : ` (${detail})`}\n`,
  );
}

/**
 * Both CLIs print prose around the URL, and each spells it differently
 * (`/pull/N` vs `/merge_requests/N`). Callers get the URL and nothing else.
 */
function extractUrl(text: string, pattern: RegExp): string {
  const matches = text.match(pattern);
  if (matches === null || matches.length === 0) {
    throw new YanError(
      FORGE_FAILED,
      'the forge did not print a merge request URL - check the repository by hand',
    );
  }
  return (matches[matches.length - 1] ?? '').replace(/\r/g, '');
}

// --- the four verbs --------------------------------------------------------

/**
 * Open a merge request and return its URL. That URL is the reference the other
 * three verbs take, and the value branching.md §6.4 stores as `unit.mr`.
 */
export function forgeMrCreate(options: MrCreateOptions): string {
  only(options, [
    'repo',
    'dir',
    'source',
    'target',
    'title',
    'body',
    'bodyFile',
    'draft',
  ]);
  const cwd = checkDir(options);
  if (!options.source || !options.target) {
    throw usageError(
      FORGE_USAGE,
      'source and target are both required - a merge request always says where it comes from and where it goes',
    );
  }
  if (!options.title) throw usageError(FORGE_USAGE, 'title is required');
  const body = bodyText(options);

  const config = readConfig();
  const host = hostFor(config);
  const repo = options.repo;

  if (config.kind === 'github') {
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
    if (repo !== undefined && repo !== '') args.push('--repo', repo);

    const result = runForgeCli({ cli: 'gh', args, cwd, host });
    if (result.code !== 0) {
      throw new YanError(
        FORGE_FAILED,
        `could not open the pull request - ${result.stderr.trim().replace(/\n/g, ' ')}`,
      );
    }
    return extractUrl(result.stdout, /https?:\/\/\S+\/pull\/[0-9]+/g);
  }

  // --no-editor and --yes together are what make this non-interactive; glab
  // otherwise opens an editor and waits, which inside a pane looks like a hang.
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
  if (repo !== undefined && repo !== '') args.push('--repo', repo);

  const result = runForgeCli({ cli: 'glab', args, cwd, host });
  if (result.code !== 0) {
    throw new YanError(
      FORGE_FAILED,
      `could not open the merge request - ${result.stderr.trim().replace(/\n/g, ' ')}`,
    );
  }
  return extractUrl(`${result.stdout}${result.stderr}`, /https?:\/\/\S+\/merge_requests\/[0-9]+/g);
}

/** Exactly one of: merged | closed | open | unknown. */
export function forgeMrState(ref: MrRef): MrState {
  only(ref, ['repo', 'dir', 'mr']);
  const mr = requireMr(ref);
  const cwd = checkDir(ref);
  const config = readConfig();
  const host = hostFor(config);

  if (config.kind === 'github') {
    const args = ['pr', 'view', ...github.refArgs(mr, ref.repo), '--json', 'state,mergedAt'];
    const result = runForgeCli({ cli: 'gh', args, cwd, host });
    if (result.code !== 0) {
      unreachable(mr, 'unknown', result);
      return gateMrState('unknown');
    }
    return gateMrState(github.mapMrState(result.stdout));
  }

  const args = ['mr', 'view', ...gitlab.refArgs(mr, ref.repo), '--output', 'json'];
  const result = runForgeCli({ cli: 'glab', args, cwd, host });
  if (result.code !== 0) {
    unreachable(mr, 'unknown', result);
    return gateMrState('unknown');
  }
  return gateMrState(gitlab.mapMrState(result.stdout));
}

/**
 * Merge now. `deleteSource` is off by default on purpose: worktree.md §7 fixes
 * the order of `yan shift done` as return the tree, THEN delete the remote
 * branch, and a forge that deleted it during the merge would take that step
 * away.
 */
export function forgeMrMerge(options: MrMergeOptions): void {
  only(options, ['repo', 'dir', 'mr', 'strategy', 'deleteSource']);
  const mr = requireMr(options);
  const cwd = checkDir(options);
  const strategy = options.strategy ?? 'merge';
  if (!['merge', 'squash', 'rebase'].includes(strategy)) {
    throw usageError(
      FORGE_USAGE,
      `unknown merge strategy '${strategy}' - use merge, squash or rebase`,
    );
  }

  const config = readConfig();
  const host = hostFor(config);

  if (config.kind === 'github') {
    const args = ['pr', 'merge', ...github.refArgs(mr, options.repo), `--${strategy}`];
    if (options.deleteSource === true) args.push('--delete-branch');
    const result = runForgeCli({ cli: 'gh', args, cwd, host });
    if (result.code !== 0) {
      throw new YanError(
        FORGE_FAILED,
        `could not merge ${mr} - ${result.stderr.trim().replace(/\n/g, ' ')}`,
      );
    }
    return;
  }

  // --auto-merge defaults to TRUE in glab: with a pipeline running it would
  // schedule the merge and report success without merging anything. yan's verb
  // means "merge it now", so the default is turned off here rather than left
  // for every caller to remember.
  const args = ['mr', 'merge', ...gitlab.refArgs(mr, options.repo), '--yes', '--auto-merge=false'];
  if (strategy === 'squash') args.push('--squash');
  if (strategy === 'rebase') args.push('--rebase');
  if (options.deleteSource === true) args.push('--remove-source-branch');

  const result = runForgeCli({ cli: 'glab', args, cwd, host });
  if (result.code !== 0) {
    throw new YanError(
      FORGE_FAILED,
      `could not merge ${mr} - ${result.stderr.trim().replace(/\n/g, ' ')}`,
    );
  }
}

/**
 * Exactly one of: green | red | pending | none.
 *
 * It does not say which job failed. That is not withheld to be tidy: the two
 * providers' job identities do not line up, and inventing a common shape for
 * them would throw information away. `red` is the fact; reading the details is
 * the shift's job.
 */
export function forgeCiState(ref: MrRef): CiState {
  only(ref, ['repo', 'dir', 'mr']);
  const mr = requireMr(ref);
  const cwd = checkDir(ref);
  const config = readConfig();
  const host = hostFor(config);

  if (config.kind === 'github') {
    const args = ['pr', 'view', ...github.refArgs(mr, ref.repo), '--json', 'statusCheckRollup'];
    const result = runForgeCli({ cli: 'gh', args, cwd, host });
    if (result.code !== 0) {
      unreachable(`CI for ${mr}`, 'pending', result);
      return gateCiState('pending');
    }
    return gateCiState(github.mapCiState(result.stdout));
  }

  const args = ['mr', 'view', ...gitlab.refArgs(mr, ref.repo), '--output', 'json'];
  const result = runForgeCli({ cli: 'glab', args, cwd, host });
  if (result.code !== 0) {
    unreachable(`CI for ${mr}`, 'pending', result);
    return gateCiState('pending');
  }
  return gateCiState(gitlab.mapCiState(result.stdout));
}
