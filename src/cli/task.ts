import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { registry, repoDir } from './shared/repo.js';
import { tasksDir } from '../util/vault.js';
import { isTty } from './shared/resolve.js';
import { enterTask, renderEntered } from './continue.js';
import { addTaskUnit, freshenClone } from './unit.js';
import { Log } from '../records/log/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';
import { withLock } from '../util/lock.js';

/**
 * `yan task new` — create a task with its units and end inside it, by handing
 * off to `yan continue`.
 *
 * The unit flags group by position: `--repo` opens a unit, and everything
 * after it belongs to that unit until the next `--repo`.
 *
 *   yan task new --title 'unify the auth header' \
 *       --repo monorepo-x --scope apps/auth  --target master \
 *       --repo monorepo-x --scope apps/admin --target master \
 *       --repo proto                         --target main
 *
 * Three units, two repositories. `--scope` and `--needs` repeat within a unit;
 * an empty scope means the whole repository. `--target` is required for every
 * unit and never defaulted.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 1 it did not work.
 */

export interface UnitSpec {
  repo: string;
  unit?: string;
  target?: string;
  mode?: string;
  branch?: string;
  base?: string;
  scope: string[];
  needs: string[];
}

/** The keys a unit flag may set, other than the repeatable two. */
type UnitScalar = 'unit' | 'target' | 'mode' | 'branch' | 'base';

/**
 * Accumulates the unit flags in argv order. One instance per parsed command
 * line — a shared one would carry the first line's units into the second.
 */
export class UnitBuilder {
  public readonly units: UnitSpec[] = [];

  public open(repo: string): void {
    this.units.push({ repo, scope: [], needs: [] });
  }

  public set(flag: UnitScalar, value: string): void {
    this.last(`--${flag}`)[flag] = value;
  }

  public push(flag: 'scope' | 'needs', value: string): void {
    this.last(`--${flag}`)[flag].push(value);
  }

  /** @throws CommandError `usage` when no `--repo` has opened a unit yet. */
  private last(flag: string): UnitSpec {
    const unit = this.units[this.units.length - 1];
    if (unit === undefined) {
      throw CommandError.usage('task_new', `${flag} belongs to a unit, so it has to come after a --repo`);
    }
    return unit;
  }
}

/**
 * A unit name from its first scope path, or the repo when it has none. Not
 * unique: the caller suffixes until it is free.
 */
export function unitNameFrom(repo: string, firstScope: string): string {
  const source = firstScope === '' ? repo : basename(firstScope.replace(/\/+$/, ''));
  const cleaned = source.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-/, '').replace(/-$/, '');
  return cleaned === '' ? 'unit' : cleaned;
}

export interface TaskNewOptions {
  title?: string;
  description?: string;
  id?: string;
  agent?: string;
  json?: boolean;
  units: readonly UnitSpec[];
}

export interface TaskNewResult {
  readonly version: 1;
  readonly task: string;
  readonly title: string;
  readonly units: readonly string[];
  readonly dir: string;
}

export interface TaskNewDeps {
  readonly add?: typeof addTaskUnit;
  /** Replaceable so a test can count fetches without a network or a real clone. */
  readonly freshen?: typeof freshenClone;
}

/** What is missing before this can run at all, as flags a caller can pass. */
export function missingForTaskNew(options: TaskNewOptions): string[] {
  const missing: string[] = [];
  if ((options.title ?? '') === '') missing.push('--title');
  if (options.units.length === 0) missing.push('--repo (with its --target)');
  return missing;
}

/**
 * Create the task directory and add every unit, fetching each distinct clone
 * once first. The task id is taken or derived under a lock.
 *
 * @throws CommandError `usage` when a title, a unit or a unit's target is
 *   missing, or the id is taken; `unit_failed` when the task was created but a
 *   unit could not be added — the task stays.
 */
export function createTask(options: TaskNewOptions, deps: TaskNewDeps = {}): TaskNewResult {
  const title = options.title ?? '';
  const missing = missingForTaskNew(options);
  if (missing.length > 0) {
    throw CommandError.usage('task_new', `missing: ${missing.join(' ')} - pass them, or run this from a terminal to be asked`,
    );
  }

  // A half-specified unit is refused rather than routed to the prompts, which
  // collect a whole task and would drop the --repo flags already typed.
  for (const unit of options.units) {
    if ((unit.target ?? '') === '') {
      throw CommandError.usage('task_new', `--target is required for --repo ${unit.repo}, and yan never guesses it: say which branch that unit delivers into`,
      );
    }
  }

  let id = options.id ?? '';
  if (id !== '' && Task.exists(id)) {
    throw CommandError.usage('task_new', `task ${id} already exists - 'yan ls' lists them`);
  }

  // The lock covers only the gap between deriving the id and taking it.
  const dir = tasksDir();
  mkdirSync(dir, { recursive: true });
  const timeout = Number.parseInt(process.env.YAN_TASK_NEW_LOCK_TIMEOUT ?? '', 10);
  withLock(join(dir, '.new.lock'), Number.isFinite(timeout) ? timeout : 30, () => {
    if (id === '') id = nextId();
    if (Task.exists(id)) {
      throw CommandError.usage('task_new', `task ${id} already exists - 'yan ls' lists them`);
    }
    Task.create(id, title);
  });

  const record = new Task(id);

  // `Task.create` has already written brief.md's heading; an empty description
  // leaves it standing alone.
  const description = options.description ?? '';
  if (description !== '') {
    writeFileSync(join(record.dir, 'brief.md'), `# ${id} ${title}\n\n${description}\n`);
  }

  const add = deps.add ?? addTaskUnit;

  // One fetch per clone, before any unit is added — units routinely share one.
  const freshen = deps.freshen ?? freshenClone;
  const fetched = new Set<string>();
  const unresolved = new Set<string>();
  for (const spec of options.units) {
    // Keyed by resolved path, so a clone named two ways is fetched once.
    let clone;
    try {
      clone = repoDir('task_new', spec.repo);
    } catch {
      // `add` below reports it, naming the unit.
      unresolved.add(spec.repo);
      continue;
    }
    if (fetched.has(clone)) continue;
    fetched.add(clone);
    freshen('yan task new', clone, spec.repo);
  }

  const added: string[] = [];
  for (const spec of options.units) {
    let name = spec.unit ?? '';
    if (name === '') {
      const base = unitNameFrom(spec.repo, spec.scope[0] ?? '');
      name = base;
      let suffix = 2;
      while (record.findUnit(name) !== undefined) {
        name = `${base}-${suffix}`;
        suffix += 1;
      }
    }
    try {
      add({
        task: id,
        unit: name,
        repo: spec.repo,
        target: spec.target ?? '',
        mode: spec.mode,
        branch: spec.branch,
        base: spec.base,
        scope: spec.scope,
        needs: spec.needs,
        fetched: !unresolved.has(spec.repo),
      });
    } catch (err) {
      throw new CommandError('task_new', 'unit_failed', `task ${id} was created, but unit '${name}' could not be added (${err instanceof Error ? err.message : String(err)}). Fix it, then finish with 'yan unit add' and enter with 'yan continue --task ${id}'`,
      );
    }
    added.push(name);
  }

  try {
    new Log(id).append(`task created: ${added.length} unit(s) - ${added.join(' ')}`);
  } catch { /* the task exists; the narration is not worth failing for */ }

  return { version: 1, task: id, title, units: added, dir: record.dir };
}

/** One past the highest `t<NNN>` on disk, zero-padded to three digits. */
function nextId(): string {
  let max = 0;
  for (const id of Task.list()) {
    const m = /^t(\d+)$/.exec(id);
    if (m === null) continue;
    // Base 10 explicitly, so t008 is eight rather than an invalid octal.
    max = Math.max(max, Number.parseInt(m[1] as string, 10));
  }
  return `t${String(max + 1).padStart(3, '0')}`;
}

interface NewFlags {
  title?: string;
  description?: string;
  id?: string;
  agent?: string;
  json?: boolean;
}

/**
 * The given options, or the ones a wizard collects when something is missing
 * and there is a tty. A command line that named any unit is handed back as it
 * stands, for `createTask` to accept or refuse.
 */
async function askWhenMissing(flags: NewFlags, units: readonly UnitSpec[]): Promise<TaskNewOptions> {
  const given: TaskNewOptions = { ...flags, units };
  if (units.length > 0 || missingForTaskNew(given).length === 0 || !isTty()) return given;

  const { askTaskNew } = await import('../ui/prompts.js');
  // Only the repositories linked on this machine can be offered.
  const answers = await askTaskNew(
    registry()
      .filter((r) => r.path !== undefined)
      .map((r) => ({ name: r.name, url: r.url, dir: r.path as string })),
    { title: flags.title, description: flags.description },
  );
  return {
    ...flags,
    title: answers.title,
    description: answers.description,
    units: answers.units.map((u) => ({
      repo: u.repo,
      unit: u.unit,
      target: u.target,
      scope: [...u.scope],
      needs: [],
    })),
  };
}

export function buildTaskCommand(): Command {
  const builder = new UnitBuilder();
  const opens = (value: string): string => {
    builder.open(value);
    return value;
  };
  const sets =
    (flag: UnitScalar) =>
    (value: string): string => {
      builder.set(flag, value);
      return value;
    };
  const pushes =
    (flag: 'scope' | 'needs') =>
    (value: string): string => {
      builder.push(flag, value);
      return value;
    };

  const newTask = new Command('new')
    .description('create a task, its brief and its units, then enter it')
    .option('--title <text>', 'what this task is called')
    .option('--description <text>', 'the contract, written into brief.md')
    .option('--id <id>', 'the task id; the next free t<NNN> when omitted')
    .option('--agent <cli>', 'override agents.yan for the enter step')
    .option('--repo <name>', 'OPENS A UNIT: a repository under repos/, or a path to a clone', opens)
    .option('--unit <name>', 'the unit name; derived from the scope when omitted', sets('unit'))
    .option('--target <branch>', 'REQUIRED per unit: which branch it delivers into', sets('target'))
    .option('--mode <mode>', 'scout | branch | mr', sets('mode'))
    .option('--branch <name>', "the unit's integration branch", sets('branch'))
    .option('--base <ref>', 'what to cut the integration branch from', sets('base'))
    .option('--scope <path>', 'repeatable within a unit; omit for the repo root', pushes('scope'))
    .option('--needs <unit>', 'repeatable within a unit', pushes('needs'))
    .option('--json', 'print what was created instead of a summary')
    .addHelpText(
      'after',
      `
usage: yan task new --title <text> [--description <text>] [--id <id>]
                    --repo <name> [--unit <name>] [--scope <path>]...
                                  --target <branch> [--mode scout|branch|mr]
                                  [--needs <unit>]... [--branch <name>] [--base <ref>]
                    [--repo <name> ...]...
                    [--agent <cli>] [--json]

Creates the task, its brief and its unit(s), then ENTERS it: the main agent
starts in this pane. There is no separate start step.

The unit flags are order sensitive: each --repo opens a unit, and the flags
after it belong to that unit until the next --repo.

  --target  Required for every unit, and never guessed.
  --scope   repeatable; omit it and the unit's scope is the repo root.
  --id      the task id; allocated as the next free t<NNN> when omitted.

With a terminal and missing values this asks with prompts. Without one it
refuses and names the flags, so nothing ever hangs waiting for an answer that
is not coming.`,
    )
    .action(
      action('yan task new', async (flags: NewFlags) => {
        const created = createTask(await askWhenMissing(flags, builder.units));

        // The record prints first; `run` then takes over the pane.
        const session = enterTask({ task: created.task, agent: flags.agent });

        if (flags.json === true) {
          out(JSON.stringify({
            version: 1,
            task: created.task,
            title: created.title,
            units: created.units,
            entered: session.record,
          }));
        } else {
          out(`task ${created.task}  ${created.title}`);
          out(`units    ${created.units.join(' ')}`);
          out(`dir      ${created.dir}`);
          out('');
          renderEntered(session.record);
        }

        if (session.run !== undefined) process.exitCode = session.run();
      }),
    );

  return new Command('task').description('tasks').addCommand(newTask);
}

export const command = buildTaskCommand();
