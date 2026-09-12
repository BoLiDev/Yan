import { Command } from 'commander';
import { CommandError } from './shared/errors.js';
import { DEFAULT_POOL_SIZE, poolSize, repoTarget } from './shared/repo.js';
import { insideTask } from './shared/task-id.js';
import { WorktreePool } from '../externals/worktree/index.js';
import { Task } from '../records/task/index.js';
import { action, out } from './shared/action.js';

/**
 * `yan tree get | return | status` — the command layer over the worktree pool:
 * it resolves which repository is meant, reads its `pool_size` from the
 * registry, and formats what the pool reports.
 *
 * `get` has two shapes. `--unit <name>` is the standing tree yan and `user`
 * share for one unit of the task they are in: every value is read off
 * task.json, so there is nothing to get wrong. The four explicit flags are
 * what a shift's dispatch and the tests use, and cut a new branch.
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

interface GetOptions extends CommonOptions {
  unit?: string;
  base?: string;
  branch?: string;
  holder?: string;
  json?: boolean;
}

/**
 * The four values `--unit` stands for, read off the unit of the task this is
 * running in. Both branch flags are the integration branch, which is what
 * makes it a standing tree rather than a new one: the branch already exists,
 * so the pool checks it out instead of cutting anything.
 *
 * @throws CommandError `usage` when the other flags were passed too, when
 *   $YAN_TASK is unset, or when the unit is unknown or has no branch.
 */
function standingTree(options: GetOptions): { repo: string; base: string; branch: string; holder: string } {
  const unit = options.unit ?? '';
  for (const [flag, value] of [['--repo', options.repo], ['--base', options.base], ['--branch', options.branch], ['--holder', options.holder]] as const) {
    if (value !== undefined && value !== '') {
      throw CommandError.usage('tree', `${flag} and --unit are alternatives - --unit reads all four off task.json`);
    }
  }
  const task = insideTask('tree');
  if (!Task.exists(task)) throw CommandError.usage('tree', `no such task: ${task}`);
  const found = new Task(task).findUnit(unit);
  if (found === undefined) {
    throw CommandError.usage('tree', `no such unit: ${unit} in ${task} - 'yan show ${task}' lists them`);
  }
  const data = found.read();
  if (data.branch === '') {
    throw CommandError.usage('tree', `unit ${unit} has no integration branch yet - 'yan unit set --branch' sets one`);
  }
  return { repo: data.repo, base: data.branch, branch: data.branch, holder: `${task}/${unit}` };
}

const get = new Command('get')
  .description('lease a tree: the unit\'s standing tree, or a new branch cut from a base')
  .option('--unit <name>', "the unit whose standing tree this is; reads the rest off task.json")
  .option('--repo <repo>', 'a repository registered under repos/, or the path to a clone')
  .option('--base <branch>', 'the integration branch the shift branch is cut from')
  .option('--branch <branch>', 'the shift branch to create')
  .option('--holder <holder>', 'who is taking it, in the form <task>/<unit>/<sid>')
  .option('--json', 'print {path, lease_id, holder}')
  .addHelpText(
    'after',
    `
'yan tree get --unit <name>' is the standing tree: the unit's integration
branch, held as <task>/<unit> for as long as the task lasts, and where yan and
\`user\` both work. It takes a pool slot, so pool_size has to cover the shifts
running at once plus one per unit.`,
  )
  .action(
    action(
      'yan tree',
      (options: GetOptions) => {
        const asked =
          options.unit !== undefined && options.unit !== ''
            ? standingTree(options)
            : { repo: '', base: options.base ?? '', branch: options.branch ?? '', holder: options.holder ?? '' };

        const target = options.unit !== undefined && options.unit !== ''
          ? repoTarget('tree', asked.repo)
          : clone(options);
        if (asked.base === '') {
          throw CommandError.usage('tree', '--base is required: a tree is always cut from an explicit integration branch',
          );
        }
        if (asked.branch === '') {
          throw CommandError.usage('tree', '--branch is required: leasing a tree creates the shift branch');
        }
        if (asked.holder === '') {
          throw CommandError.usage('tree', '--holder is required, in the form <task>/<unit>/<sid>');
        }

        const grant = new WorktreePool(target.clone).get(
          poolSize(target.key),
          asked.base,
          asked.branch,
          asked.holder,
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
pool_size in the vault's repos.json, default ${DEFAULT_POOL_SIZE}.`,
  )
  .addCommand(get)
  .addCommand(returnTree)
  .addCommand(status);
