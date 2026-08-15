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
 * order, stopping at the first unit that will not land.
 *
 * Nothing is merged without `--user-asked`, on a terminal or not: it carries
 * `user`'s answer, and no prompt can supply it on their behalf. A cycle in
 * `needs` is refused rather than resolved. Nothing is ever forced, nothing is
 * commented on, and nobody is mentioned.
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
 * The task's units in `needs` order, ties keeping declaration order. A `needs`
 * entry naming no unit of this task is reported and then ignored; units caught
 * in a `needs` cycle come back in `cycle` instead of `order`.
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

/**
 * Merge each unit's outbound MR into its target, in `needs` order, stopping at
 * the first that does not land. Narrates through `say`.
 *
 * @throws CommandError `usage` when a task, a strategy or `--user-asked` is
 *   missing, or a named unit does not exist; `cycle` when `needs` has one.
 */
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

  // Before anything is read, and never softened on a terminal.
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

    // Whether it merged is the host's answer, never git ancestry.
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

    // The integration branch is left on the remote.
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
