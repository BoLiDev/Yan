import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { agentFor, configPath } from './shared/config.js';
import { display } from './shared/display.js';
import { CommandError } from './shared/errors.js';
import { poolSize, repoTarget } from './shared/repo.js';
import { sync } from './sync.js';
import { Terminal } from '../externals/herdr/index.js';
import { WorktreePool, WorktreeError, type LeaseGrant } from '../externals/worktree/index.js';
import { Log } from '../records/log/index.js';
import { Shift } from '../records/shift/index.js';
import { Task, type UnitData } from '../records/task/index.js';
import { isYanError } from '../util/error.js';
import { yanHome } from '../util/home.js';
import { writeJson } from '../util/json.js';
import { isInside, normalizePath } from '../util/paths.js';

/**
 * `yan shift new` — dispatch a shift (agents.md §5.3, orchestration.md §2).
 *
 *   1  sync the integration branch
 *   2  lease a tree, cutting the shift branch
 *   3  write shifts/<sid>/brief.md
 *   4  ASSERT the sub-agent's working directory is not the main clone
 *   5  start the agent, and CONFIRM it
 *
 * THE ASSERTION IS THE POINT OF THIS FILE. worktree.md §7 states it as an
 * invariant of the pool: *when spawning a sub-agent, assert that its working
 * directory is not the main clone's path, and refuse to start otherwise.* A
 * main clone under `repos/` is read-only to yan except for `git fetch`; an
 * agent started there would edit, commit and push the one checkout every
 * worktree in the pool is cut from. It is also the failure that hides:
 * everything looks like it worked. So the check runs before the terminal, it
 * refuses rather than warns, and it gives the tree back on its way out.
 *
 * AND THE TREE IS ALWAYS GIVEN BACK. Every failure after step 2 returns the
 * lease before it exits, or the pool leaks a slot on every failed dispatch
 * (orchestration.md §2). That is a `finally`, not a list of exit paths.
 *
 * SYNC RUNS FIRST, and it runs by calling `sync()` rather than by copying its
 * steps. Its timing is fixed — before every new shift — so the shift branch
 * comes off a head that has just caught up and conflicts stay in one place. Two
 * of its exit codes pass straight through, because they say something this
 * command cannot improve on: 3 the pool is full, so no new shift can start at
 * all, and 5 the integration branch conflicts with target and a shift has to
 * reconcile it first.
 *
 * THE SHIFT BRANCH NAME IS ALWAYS OURS: `yan/<task>-<unit>-<sid>`. It is never
 * derived from the integration branch's name — git itself forbids `feature/X`
 * and `feature/X/s1` coexisting, and colleagues should never see our internal
 * branches. It carries no round number either: sid increases and cannot collide
 * across rounds.
 *
 * WHERE ARTIFACTS GO. `YAN_TASK_DIR` points at `tasks/<id>`, outside the
 * worktree, because the tree is wiped by `yan tree return`: a prototype written
 * inside it is either destroyed or accidentally committed into a work
 * repository.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 3 the pool is full, 4 the
 * working-directory assertion refused, 5 sync hit a conflict, 1 anything else.
 */

const RC_POOL_FULL = 3;
const RC_MAIN_CLONE = 4;
const RC_CONFLICT = 5;

/**
 * sid is DERIVED by scanning `shifts/`, never stored in a counter file: the
 * directory IS the registry. It increases and carries no round number, so the
 * second round's s7 cannot collide with the first round's s3.
 */
function nextSid(task: string): string {
  const dir = join(new Task(task).dir, 'shifts');
  let max = 0;
  try {
    for (const entry of readdirSync(dir)) {
      if (!statSync(join(dir, entry)).isDirectory()) continue;
      const m = /^s(\d+)$/.exec(entry);
      if (m !== null) max = Math.max(max, Number.parseInt(m[1] as string, 10));
    }
  } catch {
    max = 0;
  }
  return `s${max + 1}`;
}

/**
 * The harness mapping table (delivery.md §8.3 asks for a small table here and
 * says in as many words not to build an abstraction layer for it). Three
 * columns: how this harness is given an extra directory, how it is made
 * read-only for a scout, and HOW IT IS MADE TO RUN UNATTENDED. The working
 * directory is not in the table because the seam sets it with `--cwd`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE UNATTENDED COLUMN EXISTS
 * ---------------------------------------------------------------------------
 * A shift runs for hours in a pane with nobody watching it. A harness that asks
 * permission before each tool use does not "run slowly" in that setting — it
 * stops on its first command and waits forever. Observed against a real
 * dispatch: the agent read its brief, went to run one `ls`, and parked on
 *
 *   Do you want to proceed?  > 1. Yes  2. Yes, allow ...  3. No
 *
 * Granting the permission up front is consistent with how this design draws its
 * safety boundary, and does not weaken it: the agent's world is its working
 * directory plus `--add-dir`, the tree is a disposable lease that gets reset and
 * cleaned when it is returned, the shift branch is its own, and branch
 * protection on the host is the real last line of defence. The thing being
 * skipped is a prompt, not a boundary.
 *
 * scout is the exception and keeps its read-only mode: its whole contract is
 * that it does not change code, so it must not be handed a free hand.
 */
function harnessArgs(agent: string, mode: string, addDirs: readonly string[]): string[] {
  const kind = (agent.split(/[\\/]/).pop() ?? agent).replace(/\.exe$/, '');
  const args: string[] = [];
  if (kind === 'claude') {
    for (const d of addDirs) args.push('--add-dir', d);
    if (mode === 'scout') args.push('--permission-mode', 'plan');
    else args.push('--dangerously-skip-permissions');
  } else if (kind === 'codex') {
    if (mode === 'scout') args.push('--sandbox', 'read-only');
    // UNVERIFIED: codex has never run as a shift agent here — `agent start
    // --kind codex` reports ready for a codex that has exited and the root
    // cause is unestablished (orchestration.md §9). `yan doctor` says so rather
    // than letting it be discovered at dispatch time.
    else args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  return args;
}

function briefBody(options: {
  sid: string;
  task: string;
  unit: string;
  data: UnitData;
  tree: string;
  clone: string;
  branch: string;
  taskDir: string;
  work: string;
}): string {
  const { sid, task, unit, data, tree, clone, branch, taskDir } = options;
  const home = yanHome();
  const lines = [
    `# ${sid} ${unit} (task ${task})`,
    '',
    '| | |',
    '| --- | --- |',
    `| unit | ${unit} |`,
    `| repo | ${data.repo} |`,
    `| worktree | ${tree} |`,
    `| shift branch | ${branch} |`,
    `| integration branch | ${data.branch} |`,
    `| mode | ${data.mode} |`,
    `| scope | ${data.scope.length > 0 ? data.scope.join(' ') : '(the whole repository)'} |`,
    '',
    '## The work',
    '',
    options.work,
    '',
    '## How this shift works',
    '',
    `- Work only inside ${tree}. Never touch ${clone}: it is the main clone.`,
    `- You are on ${branch}, which was cut from ${data.branch}. Push it and open a merge request into ${data.branch}.`,
    `- Run the project's install step first, every time. The tree may be warm from an`,
    '  earlier shift, in which case it finishes in seconds with nothing to do.',
    '- Artifacts - prototypes, notes, screenshots, data - go in $YAN_TASK_DIR/artifacts',
    `  (${taskDir}/artifacts), NEVER inside the worktree: the tree is wiped when it is`,
    '  returned, so anything left in it is destroyed or accidentally committed.',
    '- Report only when yan has to act:',
    `      ${home}/bin/yan report <started|done|blocked|needs-decision|conflict> "<one line>"`,
  ];
  if (data.mode === 'mr') {
    // delivery.md §8.2: in mr mode the deliverable is `done: mr <url>`. The
    // shift opens its own merge request, so this note is the ONLY way the
    // address reaches yan — `yan shift done` needs it to ask the host whether
    // the work landed.
    lines.push(
      '  When you are done, the note must carry the merge request URL, because that',
      '  is how yan learns the address to ask the host about:',
      `      ${home}/bin/yan report done "mr <url>"`,
    );
  }
  lines.push(`- Check your own diff against the scope before landing: ${home}/bin/yan scope-check ${sid}`);
  if (data.mode === 'scout') {
    lines.push('- mode is scout: investigate and write it up. Do not push and do not open a merge request.');
  }
  lines.push('- Do not talk to other shifts, and do not talk to user. Everything goes through yan.');
  return `${lines.join('\n')}\n`;
}

export interface NewOptions {
  task?: string;
  unit?: string;
  sid?: string;
  agent?: string;
  brief?: string;
  briefText?: string;
  json?: boolean;
}

/** What `shift new` needs from the terminal. `Terminal` is the real one. */
export interface Dispatcher {
  createContainer(label: string): { workspace: string };
  startAgent(options: {
    container: string;
    name: string;
    kind: string;
    cwd: string;
    env?: Record<string, string>;
    argv?: readonly string[];
  }): { pane: string; agent_session?: string };
  setPaneTitle(pane: string, title: string, displayAgent?: string): void;
}

export interface Deps {
  readonly terminal?: Dispatcher;
  /** Replaceable so a test can drive `shift new` without a real git remote. */
  readonly runSync?: (task: string, unit: string) => void;
  readonly pool?: (clone: string) => Pick<WorktreePool, 'get' | 'return'>;
}

export function dispatch(options: NewOptions, deps: Deps = {}): Record<string, unknown> {
  const task = options.task ?? process.env.YAN_TASK ?? '';
  const unitName = options.unit ?? '';

  if (task === '') throw CommandError.usage('shift_new', '--task is required (or set YAN_TASK)');
  if (unitName === '') {
    throw CommandError.usage('shift_new', '--unit is required - a shift always works on one unit of a task');
  }
  if (options.brief !== undefined && options.briefText !== undefined) {
    throw CommandError.usage('shift_new', '--brief and --brief-text are alternatives - pass one');
  }
  if (options.brief !== undefined && !existsSync(options.brief)) {
    throw CommandError.usage('shift_new', `no such brief file: ${options.brief}`);
  }

  if (!Task.exists(task)) throw CommandError.usage('shift_new', `no such task: ${task}`);
  const record = new Task(task);
  const unit = record.findUnit(unitName);
  if (unit === undefined) {
    throw CommandError.usage('shift_new', `no such unit: ${unitName} in task ${task}`);
  }
  const data = unit.read();
  if (data.branch === '') {
    throw CommandError.usage('shift_new', `unit ${unitName} has no integration branch yet - 'yan unit add' or 'yan unit set --branch' sets one`,
    );
  }

  const { clone, key } = repoTarget('shift_new', data.repo, 'the unit names it, but there is no clone under repos/');

  const sid = options.sid !== undefined && options.sid !== '' ? options.sid : nextSid(task);
  const shift = new Shift(task, sid);
  if (existsSync(shift.dir)) {
    throw CommandError.usage('shift_new', `shift ${sid} already exists in task ${task} - ${shift.dir} is there already`,
    );
  }

  const branch = `yan/${task}-${unitName}-${sid}`;
  const holder = `${task}/${unitName}/${sid}`;

  const agent = options.agent !== undefined && options.agent !== '' ? options.agent : agentFor('shift');
  if (agent === '') {
    throw CommandError.usage('shift_new', `no shift agent configured - set agents.shift in ${configPath()}, or pass --agent`,
    );
  }

  // --- 1. sync --------------------------------------------------------------
  try {
    (deps.runSync ?? ((t: string, u: string) => void sync({ task: t, unit: u })))(task, unitName);
  } catch (err) {
    if (isYanError(err) && err.exitCode === RC_POOL_FULL) {
      throw new CommandError('shift_new', 'pool_full', 'the pool is full, cannot start a new shift - a shift has to finish before another can start',
        { exitCode: RC_POOL_FULL, cause: err },
      );
    }
    if (isYanError(err) && err.exitCode === RC_CONFLICT) {
      throw new CommandError('shift_new', 'conflict', `${data.branch} conflicts with ${data.target} - dispatch a shift to reconcile them before starting new work`,
        { exitCode: RC_CONFLICT, cause: err },
      );
    }
    throw new CommandError('shift_new', 'sync_failed', `cannot sync ${data.branch} before dispatching: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // --- 2. lease a tree, cutting the shift branch ----------------------------
  const pool = deps.pool?.(clone) ?? new WorktreePool(clone);
  let grant: LeaseGrant;
  try {
    grant = pool.get(poolSize(key), data.branch, branch, holder);
  } catch (err) {
    if (err instanceof WorktreeError && err.code === WorktreeError.codes.full) {
      throw new CommandError('shift_new', 'pool_full', `the pool is full, cannot start a new shift - 'yan tree status --repo ${data.repo}' shows who holds the trees`,
        { exitCode: RC_POOL_FULL, cause: err },
      );
    }
    throw err;
  }

  // From here the tree is held, so every exit gives it back. `started` is what
  // turns the undo off: once an agent is running in the tree, returning it
  // would destroy live work.
  let started = false;
  try {
    const tree = grant.path;
    const taskDir = record.dir;
    mkdirSync(shift.dir, { recursive: true });
    mkdirSync(join(taskDir, 'artifacts'), { recursive: true });

    // --- 3. write the work order -------------------------------------------
    const work =
      options.brief !== undefined
        ? readFileSync(options.brief, 'utf8')
        : (options.briefText ?? '(no work order was supplied - ask yan before changing anything)');

    // The sub-agent's working directory is the main scope path inside the
    // leased tree (delivery.md §8.3).
    let workdir = tree;
    const addDirs: string[] = [];
    if (data.scope.length > 0) {
      const first = join(tree, data.scope[0] as string);
      if (existsSync(first)) workdir = normalizePath(first);
      for (const p of data.scope.slice(1)) {
        const d = join(tree, p);
        if (existsSync(d)) addDirs.push(normalizePath(d));
      }
    }

    writeFileSync(
      join(shift.dir, 'brief.md'),
      briefBody({ sid, task, unit: unitName, data, tree, clone, branch, taskDir, work }),
    );

    // --- 4. THE ASSERTION ---------------------------------------------------
    if (isInside(clone, workdir)) {
      process.stderr.write(`yan shift new: the sub-agent would have started in ${workdir}\n`);
      process.stderr.write(`yan shift new: that is the main clone (${clone}), which yan only ever fetches into\n`);
      throw new CommandError('shift_new', 'main_clone', "refusing to start a shift in the main clone - a shift works only in a leased worktree (worktree.md §7). The tree has been returned; check the pool's configuration before retrying",
        { exitCode: RC_MAIN_CLONE },
      );
    }
    if (isInside(clone, tree)) {
      throw new CommandError('shift_new', 'main_clone', `refusing to start a shift: the pool handed out ${tree}, which is inside the main clone ${clone}`,
        { exitCode: RC_MAIN_CLONE },
      );
    }

    // --- 5. start the agent, and confirm it ---------------------------------
    const terminal = deps.terminal ?? new Terminal();
    const container = terminal.createContainer(record.containerName()).workspace;

    // run/meta.json is written BEFORE the agent starts, with the pane filled in
    // immediately afterwards. The other order would leave a running agent with
    // no record of it, and a running agent nothing has recorded is the one
    // thing yan cannot rebuild its picture from (agents.md §5.1).
    mkdirSync(shift.run, { recursive: true });
    const metaFile = join(shift.run, 'meta.json');
    const meta: Record<string, unknown> = {
      version: 1,
      task,
      sid,
      unit: unitName,
      repo: data.repo,
      branch,
      base: data.branch,
      tree,
      clone,
      workdir,
      holder,
      lease_id: grant.lease_id,
      mode: data.mode,
      agent,
      container,
      pane: '',
      mr: '',
      at: new Date().toISOString().slice(0, 19) + 'Z',
    };
    writeJson(metaFile, meta);

    // Everything after `--` reaches the agent as argv, so a brief pointer needs
    // no quoting (evidence §2). agents.md §5.6 requirement 1: a shift harness
    // accepts an initial prompt at startup, so it can be told to read its brief.
    const prompt = `Read ${join(shift.dir, 'brief.md')} and do what it says. It is your whole work order.`;
    const startedAgent = terminal.startAgent({
      container,
      name: `${sid}-${unitName}`,
      kind: agent,
      cwd: workdir,
      env: {
        YAN_HOME: yanHome(),
        YAN_TASK: task,
        YAN_TASK_DIR: taskDir,
        YAN_SID: sid,
        YAN_SHIFT_DIR: shift.dir,
      },
      argv: [...harnessArgs(agent, data.mode, addDirs), prompt],
    });
    started = true;

    meta.pane = startedAgent.pane;
    if (startedAgent.agent_session !== undefined) meta.agent_session = startedAgent.agent_session;
    writeJson(metaFile, meta);

    // Display metadata, at the moment display.md §4 names. Never fatal.
    display('could not title the shift pane', () => {
      terminal.setPaneTitle(startedAgent.pane, `${sid}-${unitName} · unit=${unitName}`, 'yan:shift');
    });

    try {
      new Log(task).append(`${sid} ${unitName}  dispatched on ${branch} (${agent} in ${workdir})`);
    } catch { /* the shift is running; the narration is not worth failing for */ }

    return meta;
  } finally {
    if (!started) {
      // Nothing has run in this tree, so there is nothing to lose. The lease id
      // is carried across so the return is refused rather than destructive if
      // somebody else already holds the slot.
      try {
        pool.return(grant.path, { leaseId: grant.lease_id, holder });
      } catch {
        process.stderr.write(`yan shift new: the tree at ${grant.path} could not be returned - 'yan tree status --repo ${data.repo}' shows the lease\n`,
        );
      }
      rmSync(shift.dir, { recursive: true, force: true });
    }
  }
}

const newShift = new Command('new')
  .description('dispatch a shift')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .option('--unit <name>', 'which unit of that task this shift works on')
  .option('--sid <sid>', 'the shift id; derived as the next free s<n> when omitted')
  .option('--agent <cli>', 'override agents.shift for this dispatch')
  .option('--brief <file>', 'a file whose contents become the body of the work order')
  .option('--brief-text <text>', 'the work order, inline')
  .option('--json', 'print the dispatch record instead of a summary')
  .addHelpText(
    'after',
    `
usage: yan shift new --task <id> --unit <name>
                     [--sid <sid>] [--agent <cli>]
                     [--brief <file> | --brief-text <text>] [--json]

The shift branch is always yan/<task>-<unit>-<sid> and is never derived from
the integration branch's name (branching.md §6.5).

Exit codes: 3 the pool is full, 4 the working directory would have been the
main clone and the dispatch was refused, 5 the integration branch conflicts
with its target and a shift has to reconcile it first.`,
  )
  .action(
    action('yan shift new', (options: NewOptions) => {
      const meta = dispatch(options);
      if (options.json === true) {
        out(JSON.stringify(meta, null, 2));
        return;
      }
      out(`${String(meta.sid)}  ${String(meta.unit)}`);
      out(`branch   ${String(meta.branch)} (from ${String(meta.base)})`);
      out(`tree     ${String(meta.tree)}`);
      out(`workdir  ${String(meta.workdir)}`);
      out(`agent    ${String(meta.agent)}  (${String(meta.pane)} in container ${String(meta.container)})`);
      out(`brief    ${join(new Shift(String(meta.task), String(meta.sid)).dir, 'brief.md')}`);
    }),
  );

export const command = new Command('shift').description('dispatch and clock out shifts').addCommand(newShift);
