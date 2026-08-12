import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { repoDirIfKnown } from './shared/repo.js';
import { RemoteGit, type MergeStrategy, type MrRef, type MrState } from '../externals/remote-git/index.js';
import { Log } from '../records/log/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';
import { normalizePath } from '../util/paths.js';

/**
 * `yan land` — merge the outbound merge requests into `target`, in `needs`
 * order.
 *
 * `user` has to ask for this.
 *
 * It is the one authority this file exists to hold:
 *
 *   merge the outbound MR into `target`   `user` has to ask for it
 *
 * and the summary underneath it: *inside your own branches and your own
 * machine, act on your own. Anything that affects `target`, or that a colleague
 * will see, requires `user` to say so.*
 *
 * Everything up to here — dispatching shifts, merging shift MRs into the
 * integration branch, opening the outbound MR with `yan mr` — `yan` does on its
 * own, because all of it happens on branches `user` owns and all of it is
 * reversible. This one is not: after it, `target` contains the work and
 * colleagues are looking at it.
 *
 * So the authority is stated twice. In the instructions the model reads, where it is told not
 * to reach for this on its own initiative; and here, as `--user-asked`, which
 * is not a confirmation prompt and not a forcing switch. It is the flag that
 * carries `user`'s answer in, exactly as `yan unit set --end` carries it into
 * an append-only history. Without it nothing is merged, on a terminal or not:
 * this is not a value the soft path could ask for on `user`'s behalf, because
 * `user` is the only source of it.
 *
 * Landing order.
 *
 * `needs` records the landing order, so the units are topologically sorted
 * before anything is merged and the run stops at the first unit that will not
 * land. Stopping matters more than finishing: a unit that lands before the one
 * it needs is exactly the breakage `needs` exists to prevent, and carrying on
 * past a failure would do it deliberately.
 *
 * A cycle is refused outright. It is not a merge order yan may pick a way out
 * of; it is a mistake in `needs` that only `user` can resolve.
 *
 * Nothing is ever forced, nothing is commented on, and nobody is mentioned.
 *
 * Exit codes: 0 fine, 2 you called this wrongly (including "user has not
 * asked"), 1 something did not land.
 */

const STRATEGIES: readonly MergeStrategy[] = ['merge', 'squash', 'rebase'];

/** What `yan land` needs from the host. `RemoteGit` is the real one. */
export interface Host {
  mrState(ref: MrRef): MrState;
  mergeMr(options: MrRef & { strategy: MergeStrategy }): void;
}

export interface LandOptions {
  task?: string;
  unit?: string[];
  strategy?: string;
  userAsked?: boolean;
  json?: boolean;
}

export interface Landed {
  readonly unit: string;
  readonly mr: string;
  readonly result: 'merged' | 'already merged';
}

export interface LandResult {
  readonly version: 1;
  readonly task: string;
  readonly strategy: MergeStrategy;
  readonly landed: Landed[];
}

/**
 * Kahn's algorithm over the task's whole unit list, so a unit's needs are
 * resolved even when they were not asked for by name. Ties keep declaration
 * order, which makes the printed plan stable and reviewable.
 *
 * A `needs` entry naming something that is not a unit here is reported and then
 * ignored: it cannot be ordered against, and refusing the whole run for a typo
 * in an unrelated unit would be worse than saying so.
 */
export function topoSort(
  units: readonly { name: string; needs: readonly string[] }[],
  note: (line: string) => void,
  taskId: string,
): { order: string[]; cycle: string[] } {
  const names = units.map((u) => u.name);
  const needsOf = new Map<string, string[]>();
  for (const u of units) {
    const kept: string[] = [];
    for (const n of u.needs) {
      if (names.includes(n)) kept.push(n);
      else note(`unit ${u.name} needs "${n}", which is not a unit of ${taskId} - ignoring it for ordering`);
    }
    needsOf.set(u.name, kept);
  }

  const order: string[] = [];
  let remaining = [...names];
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    const next: string[] = [];
    for (const u of remaining) {
      if ((needsOf.get(u) ?? []).every((n) => order.includes(n))) {
        order.push(u);
        progress = true;
      } else {
        next.push(u);
      }
    }
    remaining = next;
  }
  return { order, cycle: remaining };
}

/** The command without the process around it: everything that decides is here. */
export function land(
  options: LandOptions,
  host?: Host,
  say: (line: string) => void = () => {},
): LandResult {
  const task = options.task ?? '';
  const want = options.unit ?? [];
  const strategy = (options.strategy ?? 'merge') as MergeStrategy;

  if (task === '') throw CommandError.usage('land', '--task is required');
  if (!STRATEGIES.includes(strategy)) {
    throw CommandError.usage('land', `--strategy is merge, squash or rebase, not '${String(options.strategy)}'`);
  }

  // The authority check, before anything is read and long before anything is
  // merged. It is deliberately not softened on a TTY: `user` saying so is the
  // input, and a program cannot supply it on their behalf.
  if (options.userAsked !== true) {
    throw CommandError.usage('land', "merging into target is the one thing 'user' has to ask for. Nothing was merged. When they have asked, re-run with --user-asked",
    );
  }

  if (!Task.exists(task)) throw CommandError.usage('land', `no such task: ${task} - 'yan ls' lists them`);
  const record = new Task(task);
  const units = record.read().units;
  if (units.length === 0) throw CommandError.usage('land', `task ${task} has no units`);
  for (const u of want) {
    if (!units.some((x) => x.name === u)) {
      throw CommandError.usage('land', `no such unit: ${u} in ${task}`);
    }
  }

  const { order, cycle } = topoSort(
    units.map((u) => ({ name: u.name, needs: u.needs })),
    (line) => process.stderr.write(`yan land: ${line}\n`),
    task,
  );
  if (cycle.length > 0) {
    throw CommandError.usage('land', `the 'needs' of ${cycle.join(' ')} form a cycle, so there is no order to land them in. Nothing was merged - 'user' has to break the cycle with 'yan unit set'`,
    );
  }

  const byName = new Map(units.map((u) => [u.name, u]));
  const plan: string[] = [];
  for (const name of order) {
    if (want.length > 0 && !want.includes(name)) continue;
    const mr = byName.get(name)?.mr ?? null;
    if (mr === null || mr === '') {
      if (want.length > 0) {
        throw CommandError.usage('land', `unit ${name} has no outbound merge request - open it with 'yan mr --task ${task} --unit ${name}' first. Nothing was merged`,
        );
      }
      continue;
    }
    plan.push(name);
  }
  if (plan.length === 0) {
    throw CommandError.usage('land', `nothing to land: no unit of ${task} has an outbound merge request yet - 'yan mr' opens one`,
    );
  }

  const remote = host ?? new RemoteGit();
  const landed: Landed[] = [];

  for (const name of plan) {
    const unit = byName.get(name);
    if (unit === undefined) continue;
    const mr = unit.mr ?? '';
    const clone = repoDirIfKnown(unit.repo);
    const ref: MrRef = clone === undefined ? { mr } : { mr, dir: clone };

    // Ask before merging. Whether it merged is the host's answer and never git
    // ancestry, and the four words it may answer with are exactly the four
    // cases below.
    let state: MrState;
    try {
      state = remote.mrState(ref);
    } catch {
      state = 'unknown';
    }
    if (state === 'merged') {
      landed.push({ unit: name, mr, result: 'already merged' });
      say(`${name.padEnd(16)} ${mr}  already merged`);
      continue;
    }
    if (state === 'closed') {
      throw new CommandError('land', 'closed', `unit ${name}'s merge request ${mr} is closed, not merged, so it cannot land. Stopping here so that nothing lands out of 'needs' order - 'user' has to decide whether this round is abandoned ('yan unit set --branch')`,
      );
    }
    if (state !== 'open') {
      throw new CommandError('land', 'unknown_state', `cannot tell what state unit ${name}'s merge request ${mr} is in - the forge could not be reached, or the merge request has been deleted. Stopping here so that nothing lands out of 'needs' order`,
      );
    }

    // `deleteSource` is deliberately not passed. Deleting the integration
    // branch is not this command's business, and a forge that deletes on merge
    // would be making a judgement about work that may not all have landed.
    try {
      remote.mergeMr({ ...ref, strategy });
    } catch (err) {
      throw new CommandError('land', 'refused', `unit ${name}'s merge request ${mr} did not merge (${err instanceof Error ? err.message : String(err)}). Stopping here so that nothing lands out of 'needs' order`,
      );
    }

    landed.push({ unit: name, mr, result: 'merged' });
    try {
      new Log(task).append(`${name}  landed: ${mr} merged into ${unit.target} ('user' asked)`);
    } catch {
      process.stderr.write(`yan land: ${name} landed but log.md was not appended to\n`);
    }
    say(`${name.padEnd(16)} ${mr}  merged into ${unit.target}`);
  }

  return { version: 1, task, strategy, landed };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export const command = new Command('land')
  .description('merge the outbound merge requests into target, in `needs` order')
  .option('--task <id>', 'the task whose units are landing')
  .option('--unit <name>', 'repeatable; land only these', collect, [])
  .option('--strategy <how>', 'merge (default), squash or rebase')
  .option('--user-asked', "REQUIRED: `user` asked for this")
  .option('--json', 'machine readable output')
  .addHelpText(
    'after',
    `
usage: yan land --task <id> --user-asked [--unit <name>]...
                [--strategy merge|squash|rebase] [--json]

Merges each unit's outbound merge request into its target, topologically
sorted by \`needs\`. With no --unit, every unit that has an outbound MR.

  --user-asked  REQUIRED. Merging into target is the one action \`user\` has to
                ask for. This flag is how their answer reaches the command; it
                is not a confirmation prompt and not a force switch.

It stops at the first unit that will not land, so nothing ever lands out of
order. A cycle in \`needs\` is refused: only \`user\` can resolve that.`,
  )
  .action(
    action('yan land', (options: LandOptions) => {
      const result = land(options, undefined, options.json === true ? undefined : out);
      if (options.json === true) out(JSON.stringify(result));
    }),
  );
