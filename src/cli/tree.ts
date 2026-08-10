import { join } from 'node:path';
import { Command } from 'commander';
import { CommandError } from './shared/errors.js';
import { repoDir } from './shared/repo.js';
import { yanHome } from '../util/home.js';
import { readJsonIfPresent } from '../util/json.js';
import { WorktreePool } from '../externals/worktree/index.js';
import { action, out } from './shared/action.js';

/**
 * `yan tree get | return | status` — the entry point to the worktree pool
 * (worktree.md §7, architecture.md §5.1).
 *
 * The pool is part of yan, not a separate binary and not a wrapper around an
 * outside tool. This file is the thin command layer: it resolves which
 * repository is meant, reads `pool_size` from mem/repos.json (yan's own
 * bookkeeping, which the seam must not read), and formats what the seam
 * reports. Every decision that matters lives in `src/externals/worktree/`.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 3 a conditional return was
 * refused because the lease identity did not match (nothing was touched),
 * 1 anything else.
 */

const DEFAULT_POOL_SIZE = 8;

function poolSize(repoKey: string): number {
  const registry = readJsonIfPresent(join(yanHome(), 'mem', 'repos.json'));
  if (typeof registry !== 'object' || registry === null) return DEFAULT_POOL_SIZE;
  const entry = (registry as Record<string, unknown>)[repoKey];
  if (typeof entry !== 'object' || entry === null) return DEFAULT_POOL_SIZE;
  const size = (entry as Record<string, unknown>).pool_size;
  return typeof size === 'number' && Number.isInteger(size) && size > 0 ? size : DEFAULT_POOL_SIZE;
}

interface CommonOptions {
  repo?: string;
}

function clone(options: CommonOptions): { clone: string; key: string } {
  if (options.repo === undefined || options.repo === '') {
    throw CommandError.usage('tree', '--repo is required: a repository name under repos/, or the path to a clone',
    );
  }
  const dir = repoDir('tree', options.repo);
  return { clone: dir, key: dir.slice(dir.lastIndexOf('/') + 1) };
}

const get = new Command('get')
  .description('lease a tree and cut the shift branch in it')
  .option('--repo <repo>', 'a repository registered under repos/, or the path to a clone')
  .option('--base <branch>', 'the integration branch the shift branch is cut from')
  .option('--branch <branch>', 'the shift branch to create')
  .option('--holder <holder>', 'who is taking it, in the form <task>/<unit>/<sid>')
  .option('--json', 'print {path, lease_id, holder}')
  .action(
    action(
      'yan tree',
      (options: CommonOptions & { base?: string; branch?: string; holder?: string; json?: boolean }) => {
        const target = clone(options);
        if (!options.base) {
          throw CommandError.usage('tree', '--base is required: a tree is always cut from an explicit integration branch',
          );
        }
        if (!options.branch) {
          throw CommandError.usage('tree', '--branch is required: leasing a tree creates the shift branch');
        }
        if (!options.holder) {
          throw CommandError.usage('tree', '--holder is required, in the form <task>/<unit>/<sid>');
        }

        const grant = new WorktreePool(target.clone).get(
          poolSize(target.key),
          options.base,
          options.branch,
          options.holder,
        );
        out(options.json === true ? JSON.stringify(grant, null, 2) : grant.path);
      },
    ),
  );

const returnTree = new Command('return')
  .description('reset and clean the tree, then release the lease')
  .argument('[path]')
  .option('--repo <repo>', 'a repository registered under repos/, or the path to a clone')
  .option('--path <path>', "what 'yan tree get' printed")
  .option('--slot <n>', 'the slot number instead of the path')
  .option('--if-lease-id <id>', 'refuse unless the lease id matches')
  .option('--if-lease-holder <holder>', 'refuse unless the holder matches')
  .action(
    action(
      'yan tree',
      (
        positional: string | undefined,
        options: CommonOptions & {
          path?: string;
          slot?: string;
          ifLeaseId?: string;
          ifLeaseHolder?: string;
        },
      ) => {
        const target = clone(options);
        const which = options.path ?? positional ?? options.slot ?? '';
        if (which === '') {
          throw CommandError.usage('tree', "which tree? pass --path <path> (what 'yan tree get' printed) or --slot <n>",
          );
        }
        // The --if-* options are compared before anything destructive happens; a
        // mismatch exits 3 and touches nothing, which is what makes an
        // automatic retry safe.
        const returned = new WorktreePool(target.clone).return(which, {
          leaseId: options.ifLeaseId,
          holder: options.ifLeaseHolder,
        });
        out(`returned ${returned}`);
      },
    ),
  );

const status = new Command('status')
  .description('who holds what')
  .option('--repo <repo>', 'a repository registered under repos/, or the path to a clone')
  .option('--json', 'print the leases as an array')
  .action(
    action('yan tree', (options: CommonOptions & { json?: boolean }) => {
      const target = clone(options);
      const leases = new WorktreePool(target.clone).status();
      if (options.json === true) {
        out(JSON.stringify(leases, null, 2));
        return;
      }
      for (const l of leases) {
        out(`slot ${l.slot}\t${l.holder}\t${l.branch}\t${l.path}`);
      }
      out(`${leases.length} of ${poolSize(target.key)} trees leased`);
    }),
  );

export const command = new Command('tree')
  .description('the worktree pool')
  .addHelpText(
    'after',
    `
Returning a tree is \`git reset --hard\` plus \`git clean -fd\`, never with -x, so
gitignored dependencies and build caches survive into the next shift.

A return is refused when the tree has uncommitted changes, or when no remote
branch contains HEAD: that is the moment the work exists nowhere else. There is
no way to override it - stop and investigate instead.

The pool lives under ~/.yan-trees (YAN_POOL_ROOT overrides it) and its size is
pool_size in mem/repos.json, default ${DEFAULT_POOL_SIZE}.`,
  )
  .addCommand(get)
  .addCommand(returnTree)
  .addCommand(status);
