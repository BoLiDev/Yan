import { Command } from 'commander';
import { CommandError } from './shared/errors.js';
import { DEFAULT_POOL_SIZE, poolSize, repoTarget } from './shared/repo.js';
import { WorktreePool } from '../externals/worktree/index.js';
import { action, out } from './shared/action.js';

/**
 * `yan tree get | return | status` — the command layer over the worktree pool:
 * it resolves which repository is meant, reads its `pool_size` from the
 * registry, and formats what the pool reports.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 3 a conditional return was
 * refused because the lease identity did not match (nothing was touched),
 * 1 anything else.
 */

interface CommonOptions {
  repo?: string;
}

function clone(options: CommonOptions): { clone: string; key: string } {
  if (options.repo === undefined || options.repo === '') {
    throw CommandError.usage('tree', '--repo is required: a repository name under repos/, or the path to a clone',
    );
  }
  return repoTarget('tree', options.repo);
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
  .option('--discard', 'throw away uncommitted or unpushed work in the tree')
  .option('--user-asked', 'required with --discard: `user` said the work can go')
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
          discard?: boolean;
          userAsked?: boolean;
        },
      ) => {
        const target = clone(options);
        const which = options.path ?? positional ?? options.slot ?? '';
        if (which === '') {
          throw CommandError.usage('tree', "which tree? pass --path <path> (what 'yan tree get' printed) or --slot <n>",
          );
        }
        // Both flags: `--discard` says what to do, `--user-asked` says whose
        // decision it was. Neither alone gets past the guard.
        if (options.discard === true && options.userAsked !== true) {
          throw CommandError.usage('tree', "--discard throws away work that exists nowhere else, so it needs `user`'s word: pass --user-asked once they have given it. Nothing was touched",
          );
        }
        if (options.userAsked === true && options.discard !== true) {
          throw CommandError.usage('tree', '--user-asked answers --discard, and there is nothing here to answer without it');
        }
        // Compared before anything destructive happens: a mismatch exits 3 and
        // touches nothing.
        const returned = new WorktreePool(target.clone).return(which, {
          leaseId: options.ifLeaseId,
          holder: options.ifLeaseHolder,
          ...(options.discard === true ? { force: true } : {}),
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
branch contains HEAD: that is the moment the work exists nowhere else. The
refusal lists what is in the way, and there are two ways past it.

Commit and push what is worth keeping, and return the tree normally. Or, when
user has said the work can go, '--discard --user-asked'. Two flags because the
second is not a confirmation prompt: it records whose decision this was, and a
single flag would look like a retry.

The pool lives under ~/.yan-trees (YAN_POOL_ROOT overrides it) and its size is
pool_size in mem/repos.json, default ${DEFAULT_POOL_SIZE}.`,
  )
  .addCommand(get)
  .addCommand(returnTree)
  .addCommand(status);
