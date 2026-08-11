import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { isTty } from './shared/resolve.js';
import { enterTask, renderEntered } from './continue.js';
import { addTaskUnit } from './unit.js';
import { Log } from '../records/log/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';
import { withLock } from '../util/lock.js';

/**
 * `yan task new` — the strong create path (cli-ux.md §6, td cli-ux.md §3).
 *
 * ---------------------------------------------------------------------------
 * WHAT "STRONG" MEANS
 * ---------------------------------------------------------------------------
 *
 * Create is not "mkdir plus an empty brief". It is:
 *
 *   the contract          title and description, in brief.md
 *   the involved repos    at least one
 *   a concrete scope      including monorepo packages when they were detected
 *   at least one unit     with target, which is NEVER invented
 *   and `user` inside it  the main agent running
 *
 * THE LAST LINE IS THE ONE PEOPLE DROP. Create ends with `user` already inside
 * the task; there is no separate start step and no `yan start` in the
 * inventory. That final step is not re-implemented here — it is `yan continue`,
 * the one enter path. Two copies of "is a yan already running, and if not start
 * one" would drift, and the second copy would be the one that forgets the lock.
 *
 * What V2 changes about it is only the mechanics: the MVP created a terminal
 * container and put `user` inside it, and Herdr is already the multiplexer
 * `user` lives in, so the main agent now starts in the pane they typed in
 * (cli-ux.md §1). Nothing above that line moves.
 *
 * ---------------------------------------------------------------------------
 * THE FLAG GRAMMAR IS ORDER SENSITIVE
 * ---------------------------------------------------------------------------
 *
 * A task can involve several repositories, and each one can contribute several
 * units, so the unit flags have to group somehow. They group by position:
 *
 *     --repo <name>              OPENS A UNIT
 *     --unit --scope --target --mode --needs --branch --base
 *                                belong to the --repo before them
 *
 *   yan task new --title 'unify the auth header' \
 *       --repo monorepo-x --scope apps/auth  --target master \
 *       --repo monorepo-x --scope apps/admin --target master \
 *       --repo proto                         --target main
 *
 * Three units, two repositories, and no nesting syntax to learn. Commander
 * cannot express that as a schema, but it does not have to: it calls an
 * option's coercion function IN ARGV ORDER, so the grammar is exactly a
 * builder driven by those calls. That is `UnitBuilder` below — and it is the
 * whole reason these options declare a coercion function at all.
 *
 * `--scope` is repeatable within a unit; leaving it out means the unit's scope
 * is the repo root, which is the empty list — the prefix that matches every
 * path is no prefix at all, and `yan scope-check` already reads an empty scope
 * as "this unit restricts nothing".
 *
 * `--target` is required for EVERY unit and is never defaulted (branching.md
 * §6.4): during a release the team merges into a shared branch, in quiet
 * periods into master, and a tool that guessed would be wrong about half the
 * time, silently, until the outbound MR.
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
 * The order-sensitive half of the grammar, as a builder.
 *
 * One instance per parsed command line, which is why the command is built by a
 * factory rather than declared at module scope: a builder shared between two
 * parses in one process would carry the first command line's units into the
 * second.
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

  private last(flag: string): UnitSpec {
    const unit = this.units[this.units.length - 1];
    if (unit === undefined) {
      throw CommandError.usage('task_new', `${flag} belongs to a unit, so it has to come after a --repo`);
    }
    return unit;
  }
}

/**
 * A readable unit name from a scope path.
 *
 * A name is a convenience: it never invents a scope and never invents a target.
 * Two packages under one repository must not collide on one, though — one
 * sub-application is one unit — so the caller suffixes until it is free.
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
}

/** What is missing before this can run at all, as flags a caller can pass. */
export function missingForTaskNew(options: TaskNewOptions): string[] {
  const missing: string[] = [];
  if ((options.title ?? '') === '') missing.push('--title');
  if (options.units.length === 0) missing.push('--repo (with its --target)');
  return missing;
}

export function createTask(options: TaskNewOptions, deps: TaskNewDeps = {}): TaskNewResult {
  const title = options.title ?? '';
  const missing = missingForTaskNew(options);
  if (missing.length > 0) {
    throw CommandError.usage('task_new', `missing: ${missing.join(' ')} - pass them, or run this from a terminal to be asked`,
    );
  }

  // Every unit needs a target, and the message has to say WHICH unit. A
  // half-specified unit is deliberately NOT routed to the prompts: they collect
  // a whole task from the top and would silently drop the --repo flags that
  // were typed, and losing what `user` already said is worse than saying what
  // is missing.
  for (const unit of options.units) {
    if ((unit.target ?? '') === '') {
      throw CommandError.usage('task_new', `--target is required for --repo ${unit.repo}, and yan never guesses it: say which branch that unit delivers into (branching.md §6.4)`,
      );
    }
  }

  let id = options.id ?? '';
  if (id !== '' && Task.exists(id)) {
    throw CommandError.usage('task_new', `task ${id} already exists - 'yan ls' lists them`);
  }

  // The next free number is DERIVED by scanning tasks/, never stored in a
  // counter file — there is no registry in yan. The lock is only around the
  // gap between deriving it and taking it.
  const tasksDir = join(yanHome(), 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const timeout = Number.parseInt(process.env.YAN_TASK_NEW_LOCK_TIMEOUT ?? '', 10);
  withLock(join(tasksDir, '.new.lock'), Number.isFinite(timeout) ? timeout : 30, () => {
    if (id === '') id = nextId();
    if (Task.exists(id)) {
      throw CommandError.usage('task_new', `task ${id} already exists - 'yan ls' lists them`);
    }
    Task.create(id, title);
  });

  const record = new Task(id);

  // Task.create writes the heading; the description is this command's to add,
  // because it is the contract `user` just typed. An empty description is
  // allowed and simply leaves the heading standing.
  const description = options.description ?? '';
  if (description !== '') {
    writeFileSync(join(record.dir, 'brief.md'), `# ${id} ${title}\n\n${description}\n`);
  }

  const add = deps.add ?? addTaskUnit;
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

/**
 * The next free `t<NNN>`.
 *
 * Plain numbers in the t042 style: the readable title lives in brief.md and
 * log.md, not in the id, because the id also goes into branch names
 * (branching.md §6.5) and short is worth something there.
 */
function nextId(): string {
  let max = 0;
  for (const id of Task.list()) {
    const m = /^t(\d+)$/.exec(id);
    if (m === null) continue;
    // Base 10 explicitly, so that t008 is eight rather than an invalid octal.
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
 * The soft path: with values missing and a person at the keyboard, walk the
 * create prompts (cli-ux.md §3, §6).
 *
 * `resolve()` is not what asks here, and the difference is the point. The
 * generic helper fills in missing SCALARS; creating a task means detecting a
 * monorepo, offering its packages, and turning selections into units — a flow
 * rather than a list of options, so it has its own prompts and its own module.
 *
 * A HALF-SPECIFIED UNIT IS NOT ROUTED HERE. The wizard collects a whole task
 * from the top, so it would silently drop `--repo` flags that were typed, and
 * losing what `user` already said is worse than saying what is missing: that
 * case falls through to `createTask`'s refusal.
 */
async function askWhenMissing(flags: NewFlags, units: readonly UnitSpec[]): Promise<TaskNewOptions> {
  const given: TaskNewOptions = { ...flags, units };
  if (units.length > 0 || missingForTaskNew(given).length === 0 || !isTty()) return given;

  const { askTaskNew } = await import('../ui/prompts.js');
  const answers = await askTaskNew(yanHome(), { title: flags.title, description: flags.description });
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

  --target  REQUIRED for every unit, and never guessed (branching.md §6.4).
  --scope   repeatable; omit it and the unit's scope is the repo root.
  --id      the task id; allocated as the next free t<NNN> when omitted.

With a terminal and missing values this asks with prompts. Without one it
refuses and names the flags, so nothing ever hangs waiting for an answer that
is not coming.`,
    )
    .action(
      action('yan task new', async (flags: NewFlags) => {
        const created = createTask(await askWhenMissing(flags, builder.units));

        // The enter step, which is `yan continue` itself and not a copy of it.
        // Two phases: the record first, because it has to be printable before
        // the pane is handed to the main agent, and the blocking half after.
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
