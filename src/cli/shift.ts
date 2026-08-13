import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { agentFor, configPath } from './shared/config.js';
import { resolveContainer } from './shared/container.js';
import { display } from './shared/display.js';
import { CommandError } from './shared/errors.js';
import { poolSize, repoDirIfKnown, repoTarget } from './shared/repo.js';
import { Terminal } from '../externals/herdr/index.js';
import { RemoteGit, type MrState } from '../externals/remote-git/index.js';
import { WorktreePool, WorktreeError, type LeaseGrant } from '../externals/worktree/index.js';
import { Log } from '../records/log/index.js';
import { Shift } from '../records/shift/index.js';
import { Task, type UnitData } from '../records/task/index.js';
import { isYanError } from '../util/error.js';
import { yanHome } from '../util/home.js';
import { writeJson } from '../util/json.js';
import { deleteRemoteBranch } from '../util/git.js';
import { isInside, normalizePath } from '../util/paths.js';
import { vaultDir } from '../util/vault.js';

/**
 * `yan shift new` — dispatch a shift.
 *
 *   1  lease a tree, cutting the shift branch `yan/<task>-<unit>-<sid>`
 *   2  write shifts/<sid>/brief.md
 *   3  refuse if the sub-agent's working directory is inside the main clone
 *   4  start the agent, and confirm it
 *
 * The tree is returned and the shift directory removed on any failure before
 * the agent is running. Nothing here fetches or touches `target`: a shift's
 * merge request goes into the integration branch, and that is a later command.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 3 the pool is full, 4 the
 * working directory would have been the main clone, 1 anything else.
 */

const RC_POOL_FULL = 3;
const RC_MAIN_CLONE = 4;

/** One past the highest `s<n>` under `shifts/`, counting every round. */
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
 * The flags one harness needs: the extra directories, and either running
 * unattended or, for a `scout`, running read-only. An unflagged harness would
 * stop at its first permission prompt in a pane nobody is watching.
 *
 * A scout in either harness cannot run a build or a test suite, because both
 * write.
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
    else args.push('--dangerously-bypass-approvals-and-sandbox');

    // Hooks the target repository ships run without review. Codex's
    // hook-review prompt is one Herdr classifies as `idle`, so a shift that
    // met it would park in an unfocused pane and never wake anybody.
    // `user` took this decision knowing what it costs.
    args.push('--dangerously-bypass-hook-trust');
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
    lines.push(
      '  When you are done, the note must carry the merge request URL, because that',
      '  is how yan learns the address to ask the host about:',
      `      ${home}/bin/yan report done "mr <url>"`,
    );
  }
  lines.push(
    '- The scope in the table above is where this work belongs. Going outside it is not',
    "  forbidden, but it is not yours to decide quietly: report it, say what you need and",
    '  why, and let yan answer.',
  );
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
  /** How the task's existing container is found before one is created. */
  workspaceOfPane(pane: string): string | undefined;
  startAgent(options: {
    container: string;
    name: string;
    kind: string;
    cwd: string;
    label?: string;
    env?: Record<string, string>;
    argv?: readonly string[];
  }): { pane: string; agent_session?: string };
  setPaneTitle(pane: string, title: string, displayAgent?: string): void;
}

export interface Deps {
  readonly terminal?: Dispatcher;
  readonly pool?: (clone: string) => Pick<WorktreePool, 'get' | 'return'>;
}

/**
 * Dispatch one shift and return the record written to `run/meta.json`.
 *
 * @throws CommandError `usage` for a missing task, unit or agent, `pool_full`
 *   (exit 3) when no tree is free, `main_clone` (exit 4) when the agent would
 *   have started inside the main clone.
 */
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

  const { clone, key } = repoTarget('shift_new', data.repo, 'the unit names it, but nothing on this machine says where it is');

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

  // --- 1. lease a tree, cutting the shift branch ----------------------------
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

  // From here the tree is held, so every exit gives it back — until an agent
  // is running in it, after which returning it would destroy live work.
  let started = false;
  try {
    const tree = grant.path;
    const taskDir = record.dir;
    mkdirSync(shift.dir, { recursive: true });
    mkdirSync(join(taskDir, 'artifacts'), { recursive: true });

    // --- 2. write the work order -------------------------------------------
    const work =
      options.brief !== undefined
        ? readFileSync(options.brief, 'utf8')
        : (options.briefText ?? '(no work order was supplied - ask yan before changing anything)');

    // The sub-agent starts in the unit's first scope path; the rest reach it
    // as extra directories.
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

    // --- 3. refuse the main clone -------------------------------------------
    if (isInside(clone, workdir)) {
      process.stderr.write(`yan shift new: the sub-agent would have started in ${workdir}\n`);
      process.stderr.write(`yan shift new: that is the main clone (${clone}), which yan only ever fetches into\n`);
      throw new CommandError('shift_new', 'main_clone', "refusing to start a shift in the main clone - a shift works only in a leased worktree. The tree has been returned; check the pool's configuration before retrying",
        { exitCode: RC_MAIN_CLONE },
      );
    }
    if (isInside(clone, tree)) {
      throw new CommandError('shift_new', 'main_clone', `refusing to start a shift: the pool handed out ${tree}, which is inside the main clone ${clone}`,
        { exitCode: RC_MAIN_CLONE },
      );
    }

    // --- 4. start the agent, and confirm it ---------------------------------
    const terminal = deps.terminal ?? new Terminal();
    const container = resolveContainer(task, terminal, record.containerName());

    // Written before the agent starts, so a running agent is always recorded;
    // the pane is filled in immediately afterwards.
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

    const prompt = `Read ${join(shift.dir, 'brief.md')} and do what it says. It is your whole work order.`;
    const startedAgent = terminal.startAgent({
      container,
      name: `${sid}-${unitName}`,
      kind: agent,
      cwd: workdir,
      label: `${sid}-${unitName}`,
      env: {
        YAN_HOME: yanHome(),
        // Explicit, so `yan vault use` elsewhere cannot move a running shift.
        YAN_VAULT: vaultDir(),
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

    display('could not title the shift pane', () => {
      terminal.setPaneTitle(startedAgent.pane, `${sid}-${unitName} · unit=${unitName}`, 'yan:shift');
    });

    try {
      new Log(task).append(`${sid} ${unitName}  dispatched on ${branch} (${agent} in ${workdir})`);
    } catch { /* the shift is running; a missing log line is not worth failing for */ }

    return meta;
  } finally {
    if (!started) {
      // The lease id goes with it, so a slot somebody else now holds is
      // refused rather than wiped.
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
the integration branch's name.

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

// --- shift done -------------------------------------------------------------

/**
 * `yan shift done` — clock a shift out, in this order:
 *
 *   verify the MR is merged
 *     → write outcome.md
 *       → write the log line
 *         → rm -rf run/
 *           → return the tree
 *             → then delete the remote shift branch
 *
 * Merged is the host's answer and never git ancestry, because a squash-merged
 * branch is not an ancestor of what it landed on. The tree goes back before
 * the branch is deleted: deleting first drops the remote-tracking ref, and the
 * pool's orphan-commit guard would then refuse the return and strand the slot.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 4 the merge request has not
 * merged so there is nothing to clock out yet, 1 anything else.
 */

const RC_NOT_MERGED = 4;

export interface DoneOptions {
  task?: string;
  mr?: string;
  outcome?: string;
  keepPane?: boolean;
  json?: boolean;
}

/** What `shift done` needs from the terminal. `Terminal` is the real one. */
export interface Closer {
  close(pane: string): void;
  clearPaneTitle(pane: string): void;
}

export interface DoneDeps {
  readonly terminal?: Closer;
  readonly pool?: (clone: string) => Pick<WorktreePool, 'return' | 'status'>;
  readonly mrStateOf?: (mr: string, dir: string | undefined) => MrState;
  readonly deleteBranch?: (clone: string, branch: string) => boolean;
}

export interface DoneResult {
  readonly version: 1;
  readonly sid: string;
  readonly task: string;
  readonly unit: string;
  readonly branch: string;
  readonly mr: string;
  readonly mr_state: 'merged';
  readonly tree: string;
  readonly outcome_by: string;
  readonly run_removed: true;
  readonly tree_returned: boolean;
  readonly branch_deleted: boolean;
}

/**
 * The lease this shift still holds, found by asking every unit's pool for the
 * holder `<task>/<unit>/<sid>`. `undefined` means it clocked out cleanly;
 * anything else means a teardown stopped before the tree came back.
 */
function resumeFromPool(
  task: string,
  sid: string,
  deps: DoneDeps,
): { unit: string; clone: string; path: string; branch: string; holder: string; leaseId: string } | undefined {
  if (task === '' || !Task.exists(task)) return undefined;
  for (const unit of new Task(task).read().units) {
    const clone = repoDirIfKnown(unit.repo);
    if (clone === undefined) continue;
    let leases;
    try {
      leases = (deps.pool?.(clone) ?? new WorktreePool(clone)).status();
    } catch {
      continue;
    }
    const held = leases.find((l) => l.holder === `${task}/${unit.name}/${sid}`);
    if (held !== undefined) {
      return {
        unit: unit.name,
        clone,
        path: held.path,
        branch: held.branch,
        holder: held.holder,
        leaseId: held.lease_id,
      };
    }
  }
  return undefined;
}

/**
 * Clock a shift out, resuming an interrupted teardown when `run/` is already
 * gone but a tree is still leased.
 *
 * @throws CommandError `usage` for a missing sid, an unknown outcome file, no
 *   recorded merge request, or a shift that has fully clocked out;
 *   `not_merged` (exit 4) when the host says it has not merged;
 *   `return_refused` when the tree could not go back, in which case the remote
 *   branch is left alone.
 */
export function clockOut(sid: string | undefined, options: DoneOptions, deps: DoneDeps = {}): DoneResult {
  if (sid === undefined || sid === '') {
    throw CommandError.usage('shift_done', 'a shift id is required');
  }
  if (options.outcome !== undefined && !existsSync(options.outcome)) {
    throw CommandError.usage('shift_done', `no such outcome file: ${options.outcome}`);
  }

  const shift = Shift.resolve(sid, options.task ?? '');
  const meta = shift.meta();

  let unit = meta.unit ?? '';
  let branch = meta.branch ?? '';
  let tree = meta.tree ?? '';
  let clone = meta.clone ?? '';
  let holder = meta.holder ?? '';
  let leaseId = meta.leaseId ?? '';
  let pane = meta.agentId ?? '';
  // The shift opens its own MR, so the URL usually arrives on its `done` event.
  let mr = options.mr ?? meta.mr ?? shift.reportedMr() ?? '';

  let resuming = false;
  if (!shift.isLive()) {
    const resume = resumeFromPool(shift.task, shift.sid, deps);
    if (resume === undefined) {
      throw CommandError.usage('shift_done', `shift ${shift.label()} has already clocked out - run/ is gone, which is the fact that says so`,
      );
    }
    ({ unit, branch, clone, holder } = resume);
    tree = resume.path;
    leaseId = resume.leaseId;
    pane = '';
    resuming = true;
    process.stderr.write(`yan shift done: ${shift.label()} left a tree leased - finishing the teardown that stopped at the tree return\n`,
    );
  }
  if (branch === '') {
    throw new CommandError('shift_done', 'no_branch', `run/meta.json does not say which shift branch ${shift.label()} is on - it cannot be cleaned up automatically`,
    );
  }

  // The fallback for a shift dispatched before meta.json recorded the clone.
  if (clone === '' && shift.task !== '' && unit !== '' && Task.exists(shift.task)) {
    const repo = new Task(shift.task).findUnit(unit)?.read().repo ?? '';
    const guess = repo === '' ? undefined : repoDirIfKnown(repo);
    if (guess !== undefined) clone = guess;
  }

  const outcomeFile = join(shift.dir, 'outcome.md');
  let outcomeBy: string;

  // Steps 1 to 4 already ran in the attempt that stopped, and the URL they
  // needed went with run/, so a resume starts at the tree return.
  if (!resuming) {
    // --- 1. is it merged? ---------------------------------------------------
    if (mr === '') {
      throw CommandError.usage('shift_done', `no merge request recorded for ${shift.label()} - pass --mr <url>. Whether the work landed is the host's answer, and yan will not guess it from git history`,
      );
    }
    const dir = tree !== '' && existsSync(tree) ? tree : clone !== '' && existsSync(clone) ? clone : undefined;
    const ask = deps.mrStateOf ?? ((url: string, d: string | undefined) => new RemoteGit().mrState({ mr: url, dir: d }));
    const state = ask(mr, dir);
    if (state !== 'merged') {
      throw new CommandError('shift_done', 'not_merged', `${mr} is '${state}', not merged - a shift clocks out when its merge request has been merged into the integration branch, and nothing sooner`,
        { exitCode: RC_NOT_MERGED },
      );
    }

    // --- 2. outcome.md ------------------------------------------------------
    // The shift writes this itself; what follows is the fallback for one that
    // did not, and it is recorded as yan's rather than the shift's.
    if (existsSync(outcomeFile)) {
      outcomeBy = 'shift';
    } else if (options.outcome !== undefined) {
      outcomeBy = 'yan';
      writeFileSync(outcomeFile, readFileSync(options.outcome, 'utf8'));
    } else {
      outcomeBy = 'yan';
      writeFileSync(
        outcomeFile,
        [
          `# ${shift.sid} ${unit}`,
          '',
          `- shift branch: ${branch}`,
          `- merge request: ${mr} (merged)`,
          `- events reported: ${shift.eventCount()}`,
          '',
          'Written by yan when the shift clocked out: the shift did not leave an',
          'outcome of its own, so this records only what could be observed.',
          '',
        ].join('\n'),
      );
    }

    // --- 3. the log line ----------------------------------------------------
    if (shift.task !== '') {
      try {
        new Log(shift.task).append(`${shift.sid} ${unit}  ${mr} merged into the integration branch`);
      } catch { /* the teardown matters more than its log line */ }
    }

    // --- 4. rm -rf run/, the whole throwaway layer --------------------------
    rmSync(shift.run, { recursive: true, force: true });
  } else {
    // Resuming: outcome.md survived from the interrupted attempt's step 2, and
    // it is where the merge request URL can still be found.
    outcomeBy = existsSync(outcomeFile) ? 'written earlier' : 'missing';
    if (mr === '' && existsSync(outcomeFile)) {
      mr = /https?:\/\/\S+/.exec(readFileSync(outcomeFile, 'utf8'))?.[0] ?? '';
    }
    if (mr === '') mr = '(recorded in outcome.md)';
  }

  // --- 5. return the tree, before the branch is deleted ---------------------
  let returned = '';
  if (tree === '') {
    process.stderr.write(`yan shift done: no worktree recorded for ${shift.label()}, so there is none to return\n`);
  } else if (clone === '') {
    process.stderr.write(`yan shift done: the main clone of ${shift.label()} is not recorded, so the tree at ${tree} must be returned by hand\n`,
    );
  } else {
    try {
      returned = (deps.pool?.(clone) ?? new WorktreePool(clone)).return(tree, { leaseId, holder });
    } catch (err) {
      // Fatal: a refusal here means the commits may exist nowhere else, and
      // deleting the remote branch next would make that permanent.
      throw new CommandError('shift_done', 'return_refused', `the tree at ${tree} could not be returned, so the remote branch ${branch} has NOT been deleted - investigate before anything else touches it (${err instanceof Error ? err.message : String(err)})`,
        { exitCode: isYanError(err) ? err.exitCode : 1, cause: err },
      );
    }
  }

  // --- 6. and only now, the remote shift branch -----------------------------
  let deleted = false;
  if (clone !== '' && existsSync(clone)) {
    const drop =
      deps.deleteBranch ?? ((c: string, b: string) => deleteRemoteBranch(c, 'origin', b).code === 0);
    deleted = drop(clone, branch);
    if (!deleted) {
      process.stderr.write(`yan shift done: the remote branch ${branch} could not be deleted (it may already be gone) - the tree is back in the pool either way\n`,
      );
    }
  }

  // --- 7. the agent's pane, never fatal ------------------------------------
  if (options.keepPane !== true && pane !== '') {
    const terminal = deps.terminal ?? new Terminal();
    display('could not clear the shift pane title', () => {
      terminal.clearPaneTitle(pane);
    });
    display('could not close the shift pane', () => {
      terminal.close(pane);
    });
  }

  return {
    version: 1,
    sid: shift.sid,
    task: shift.task,
    unit,
    branch,
    mr,
    mr_state: 'merged',
    tree: returned !== '' ? returned : tree,
    outcome_by: outcomeBy,
    run_removed: true,
    tree_returned: returned !== '',
    branch_deleted: deleted,
  };
}

const doneShift = new Command('done')
  .description('clock a shift out once its merge request has merged')
  .argument('[sid]')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .option('--mr <url>', "the shift branch's merge request, when run/meta.json has none")
  .option('--outcome <file>', 'a file whose contents become outcome.md if the shift wrote none')
  .option('--keep-pane', "leave the agent's pane open")
  .option('--json', 'print the teardown record instead of a summary')
  .addHelpText(
    'after',
    `
usage: yan shift done <sid> [--task <id>] [--mr <url>]
                      [--outcome <file>] [--keep-pane] [--json]

Clocks a shift out, in the one order that survives a squash merge:

  the merge request is merged -> outcome.md -> the log line
    -> rm -rf run/ -> return the tree -> delete the remote shift branch

Whether it merged is asked of the host, never inferred from git ancestry: a
squash-merged branch is not an ancestor of the branch it landed on.

Exit code 4 means the merge request has not merged, so there is nothing to
clock out yet.`,
  )
  .action(
    action('yan shift done', (sid: string | undefined, options: DoneOptions) => {
      const r = clockOut(sid, options);
      if (options.json === true) {
        out(JSON.stringify(r));
        return;
      }
      out(`${r.sid} clocked out`);
      out(`mr       ${r.mr} (merged)`);
      out(`outcome  ${join(new Shift(r.task, r.sid).dir, 'outcome.md')} (${r.outcome_by})`);
      out('run      removed');
      out(`tree     ${r.tree_returned ? r.tree : 'not returned'}`);
      out(`branch   ${r.branch} ${r.branch_deleted ? 'deleted on origin' : 'left on origin'}`);
    }),
  );

export const command = new Command('shift')
  .description('dispatch and clock out shifts')
  .addCommand(newShift)
  .addCommand(doneShift);
