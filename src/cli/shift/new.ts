import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from '../shared/action.js';
import { cliKind, modelFlags, resolveShift, runsAs, type ShiftSpec } from '../shared/config.js';
import { resolveContainer } from '../shared/container.js';
import { display } from '../shared/display.js';
import { placementOf } from '../shared/placement.js';
import { readNote, appendLog } from '../shared/note.js';
import { repoTarget } from '../shared/repo.js';
import { insideTask, existingTask } from '../shared/task-id.js';
import { returnLease } from '../shared/teardown.js';
import { agentNameFor, Terminal, type AgentStatus, type SplitAt, type TabLayout } from '../../externals/herdr/index.js';
import { WorktreePool, type LeaseGrant } from '../../externals/worktree/index.js';
import { opensMr, Shift, type ShiftMeta, type ShiftMetaPlaceholder } from '../../records/shift/index.js';
import { Task, type UnitData } from '../../records/task/index.js';
import { YanError, isYanError } from '../../util/error.js';
import { yanHome } from '../../util/home.js';
import { writeJson } from '../../util/json.js';
import { withLock } from '../../util/lock.js';
import { branchExists, push, remoteBranchExists } from '../../util/git.js';
import { isInside, normalizePath } from '../../util/paths.js';
import { vaultDir } from '../../util/vault.js';
import { isoSecond } from '../../util/time.js';
import { nextNumbered } from '../../util/names.js';
import { briefBody } from './brief.js';

/**
 * `yan shift new` — dispatch a shift.
 *
 *   1  claim the sid, the container and the pane to split, under a lock
 *   2  lease a tree, cutting the shift branch `yan/<task>-<unit>-<sid>`
 *   3  write shifts/<sid>/brief.md, and teardown.json beside it
 *   4  refuse if the sub-agent's working directory is inside the main clone
 *   5  start the agent, and confirm it
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
  return nextNumbered(Shift.allIn(task).map((shift) => shift.sid), 's');
}

/** How long a dispatch waits for the task's prologue lock. */
const DISPATCH_LOCK_SECONDS = 120;

/**
 * Claim `shifts/<sid>/` for this dispatch, and answer with the sid it got.
 * The directory is the claim: `mkdir` without `recursive` fails rather than
 * succeeding on one that is already there, so two dispatches racing for the
 * same `s<n>` cannot both walk away believing they hold it — which is how they
 * used to end up cutting the same shift branch.
 *
 * @throws YanError `shift_new_usage` when an explicitly named sid is already taken.
 */
function claimSid(task: string, asked: string | undefined): string {
  const shifts = join(new Task(task).dir, 'shifts');
  mkdirSync(shifts, { recursive: true });

  if (asked !== undefined && asked !== '') {
    try {
      mkdirSync(join(shifts, asked));
    } catch {
      throw YanError.usage('shift_new_usage', `shift ${asked} already exists in task ${task} - ${join(shifts, asked)} is there already`,
      );
    }
    return asked;
  }

  let sid = nextSid(task);
  for (;;) {
    try {
      mkdirSync(join(shifts, sid));
      return sid;
    } catch {
      sid = `s${Number.parseInt(sid.slice(1), 10) + 1}`;
    }
  }
}

/**
 * Make sure the unit's integration branch is on origin before a shift is cut
 * from it. `unit add` creates the branch in the clone alone, so the first
 * shift of a round finds no base on the forge and has to push somebody else's
 * branch before it can open its merge request.
 *
 * Never forced, and never fatal: a push that fails costs a line on stderr, and
 * the branch is still there to cut from locally.
 */
function publishBase(clone: string, branch: string): void {
  if (remoteBranchExists(clone, branch) || !branchExists(clone, branch)) return;

  const pushed = push(clone, ['-u', 'origin', branch]);
  if (pushed.code === 0) return;
  process.stderr.write(`yan shift new: ${branch} is not on origin and could not be pushed (${pushed.stderr.trim()}) - the shift's merge request will have no base until it is\n`);
}

/**
 * The whole argv one harness needs: the extra directories and running
 * unattended. An unflagged harness would stop at its first permission prompt
 * in a pane nobody is watching.
 *
 * The work order is not in here for claude and codex: it is typed in once the
 * harness is up, by `startAgent`. Herdr's `agent start` returns only when the
 * agent is ready for input, and one started with its prompt in argv goes
 * straight to work and is still working at the deadline - every shift came
 * back as `timeout`. Agy keeps its prompt on the command line, because `-i`
 * is what makes it act on one and then stay open.
 *
 * A shift that delivers a report rather than a merge request - `explore` and
 * `uix` - runs unattended too. Read-only by permission mode is the one thing
 * it must not be: `--permission-mode plan` ends at "ready to execute - would
 * you like to proceed?", which is an approval nobody is there to give, so
 * every scout parked there and delivered nothing. What keeps it from pushing
 * is its brief, plus a deny rule that makes the obvious way to do it fail;
 * what makes that affordable is that its tree is thrown away and its branch is
 * never pushed. The gain is that it can run the build and the test suite it is
 * reporting on.
 */
function harnessArgv(
  spec: ShiftSpec,
  workdir: string,
  addDirs: readonly string[],
  prompt: string,
): string[] {
  const kind = cliKind(spec.cli);
  const args: string[] = [];
  if (kind === 'claude') {
    args.push(...modelFlags(spec.cli, spec));
    for (const d of addDirs) args.push('--add-dir', d);
    args.push('--dangerously-skip-permissions');
    if (!opensMr(spec.scenario)) args.push('--disallowed-tools', 'Bash(git push:*)');
  } else if (kind === 'codex') {
    args.push(...modelFlags(spec.cli, spec));
    if (!opensMr(spec.scenario)) args.push('--sandbox', 'read-only');
    else args.push('--dangerously-bypass-approvals-and-sandbox');

    // Hooks the target repository ships run without review. Codex's
    // hook-review prompt is one Herdr classifies as `idle`, so a shift that
    // met it would park in an unfocused pane and never wake anybody.
    // `user` took this decision knowing what it costs.
    args.push('--dangerously-bypass-hook-trust');
  } else if (kind === 'agy') {
    // Agy ignores the directory it starts in: its workspace is what --add-dir
    // names. A prompt it should act on and then stay open for is -i's.
    args.push(...modelFlags(spec.cli, spec));
    for (const d of [workdir, ...addDirs]) args.push('--add-dir', d);
    args.push('--dangerously-skip-permissions', '-i', prompt);
  }
  return args;
}

/**
 * Where the sub-agent starts, and the other directories it is given: the
 * unit's first scope path and the rest of them, those the tree has.
 */
function workdirOf(tree: string, scope: readonly string[]): { workdir: string; addDirs: string[] } {
  let workdir = tree;
  const addDirs: string[] = [];
  if (scope.length > 0) {
    const first = join(tree, scope[0] as string);
    if (existsSync(first)) workdir = normalizePath(first);
    for (const p of scope.slice(1)) {
      const d = join(tree, p);
      if (existsSync(d)) addDirs.push(normalizePath(d));
    }
  }
  return { workdir, addDirs };
}

/** The dispatch record, as it is before the agent has a pane. */
function metaFor(options: {
  task: string;
  sid: string;
  unit: string;
  data: UnitData;
  shiftBranch: string;
  grant: LeaseGrant;
  clone: string;
  workdir: string;
  holder: string;
  spec: ShiftSpec;
  container: string;
}): ShiftMeta {
  const { data, grant, spec } = options;
  return {
    version: 1,
    task: options.task,
    sid: options.sid,
    unit: options.unit,
    repo: data.repo,
    branch: options.shiftBranch,
    base: data.branch,
    tree: grant.path,
    clone: options.clone,
    workdir: options.workdir,
    holder: options.holder,
    lease_id: grant.lease_id,
    agent: spec.cli,
    scenario: spec.scenario,
    skills: [...spec.skills],
    tier: spec.tier,
    model: spec.model,
    effort: spec.effort,
    container: options.container,
    pane: '',
    mr: '',
    at: isoSecond(),
  };
}

export interface NewOptions {
  task?: string;
  unit?: string;
  sid?: string;
  scenario?: string;
  tier?: string;
  brief?: string;
  briefText?: string;
  note?: string;
  json?: boolean;
}

/** What `shift new` needs from the terminal. `Terminal` is the real one. */
export interface Dispatcher {
  createContainer(label: string): { workspace: string };
  /** How the task's existing container is found before one is created. */
  workspaceOfPane(pane: string): string | undefined;
  /** How the main agent's tab is read, to place the shift in it. */
  tabLayout(pane: string): TabLayout | undefined;
  startAgent(options: {
    container: string;
    split?: SplitAt;
    name: string;
    kind: string;
    cwd: string;
    label?: string;
    env?: Record<string, string>;
    argv?: readonly string[];
    prompt?: string;
  }): { pane: string; status: AgentStatus; agent_session?: string };
  setPaneTitle(pane: string, title: string, displayAgent?: string): void;
}

export interface Deps {
  readonly terminal?: Dispatcher;
  readonly pool?: (clone: string) => Pick<WorktreePool, 'get' | 'return'>;
}

/**
 * Dispatch one shift and return the record written to `run/meta.json`.
 *
 * @throws YanError `shift_new_usage` for a missing task, unit or agent, `shift_new_pool_full`
 *   (exit 3) when no tree is free, `shift_new_main_clone` (exit 4) when the agent would
 *   have started inside the main clone.
 */
export function dispatch(options: NewOptions, deps: Deps = {}): ShiftMeta {
  const task = options.task ?? insideTask('shift_new');
  const unitName = options.unit ?? '';

  if (unitName === '') {
    throw YanError.usage('shift_new_usage', '--unit is required - a shift always works on one unit of a task');
  }
  if (options.brief !== undefined && options.briefText !== undefined) {
    throw YanError.usage('shift_new_usage', '--brief and --brief-text are alternatives - pass one');
  }
  const note = readNote('shift_new', options.note);
  if (options.brief !== undefined && !existsSync(options.brief)) {
    throw YanError.usage('shift_new_usage', `no such brief file: ${options.brief}`);
  }

  const record = existingTask('shift_new', task);
  const data = record.findUnit(unitName);
  if (data === undefined) {
    throw YanError.usage('shift_new_usage', `no such unit: ${unitName} in task ${task}`);
  }
  if (data.branch === '') {
    throw YanError.usage('shift_new_usage', `unit ${unitName} has no integration branch yet - 'yan unit add' or 'yan unit set --branch' sets one`,
    );
  }

  const { clone, poolSize } = repoTarget('shift_new', data.repo, 'the unit names it, but nothing on this machine says where it is');

  // Before anything is claimed: the shift's merge request needs this branch on
  // origin to have a base, and pushing it is yan's to do.
  publishBase(clone, data.branch);

  const spec = resolveShift('shift_new', options.scenario, options.tier);
  const agent = spec.cli;

  const taskDir = record.dir;
  const terminal = deps.terminal ?? new Terminal();

  // --- 1. claim the sid, the container and the placement, one dispatch of
  // this task at a time ------------------------------------------------------
  //
  // All three are read off what the task already has, so two dispatches
  // reading at once agree and then diverge: the same `s<n>`, and so the same
  // shift branch, and a container each because neither can see a shift the
  // other has not written down yet. The lock makes the read and the write one
  // step; the placeholder run/meta.json is the write, because a container is
  // found by asking this task's live shifts which one they are in.
  //
  // The placement is not fully covered: the placeholder records no pane, and
  // the split happens in `startAgent`, after the lock is released, so two
  // dispatches started together can both pick the same pane to split. Each
  // still gets a pane of its own; the tab is only less even than the rule
  // makes it.
  const claimed = withLock(join(taskDir, 'dispatch.lock'), DISPATCH_LOCK_SECONDS, () => {
    const sid = claimSid(task, options.sid);
    const shift = new Shift(task, sid);
    const container = resolveContainer(task, terminal, record.containerName());
    const split = placementOf(task, container, terminal);
    mkdirSync(shift.run, { recursive: true });
    const placeholder: ShiftMetaPlaceholder = { version: 1, task, sid, unit: unitName, container, pane: '' };
    writeJson(join(shift.run, 'meta.json'), placeholder);
    return { sid, shift, container, split };
  });
  const { sid, shift, container, split } = claimed;

  const shiftBranch = `yan/${task}-${unitName}-${sid}`;
  const holder = `${task}/${unitName}/${sid}`;

  // From here the shift directory is claimed, so every exit before an agent is
  // running gives it back along with the tree.
  let started = false;
  let grant: LeaseGrant | undefined;
  try {
    // --- 2. lease a tree, cutting the shift branch --------------------------
    const pool = deps.pool?.(clone) ?? new WorktreePool(clone);
    try {
      grant = pool.get(poolSize, data.branch, shiftBranch, holder);
    } catch (err) {
      if (isYanError(err) && err.code === 'worktree_full') {
        throw new YanError('shift_new_pool_full', `the pool is full, cannot start a new shift - 'yan tree status --repo ${data.repo}' shows who holds the trees`,
          { exitCode: RC_POOL_FULL, cause: err },
        );
      }
      throw err;
    }

    const tree = grant.path;
    mkdirSync(join(taskDir, 'artifacts'), { recursive: true });

    // --- 3. write the work order -------------------------------------------
    const work =
      options.brief !== undefined
        ? readFileSync(options.brief, 'utf8')
        : (options.briefText ?? '(no work order was supplied - ask yan before changing anything)');

    const { workdir, addDirs } = workdirOf(tree, data.scope);

    writeFileSync(
      join(shift.dir, 'brief.md'),
      briefBody({ sid, task, unit: unitName, data, tree, clone, shiftBranch, taskDir, work, skills: spec.skills, scenario: spec.scenario }),
    );
    // Beside the brief rather than in run/, which clocking out deletes before
    // the part of the teardown that can stop and be run again.
    shift.writeTeardown({ version: 1, scenario: spec.scenario, unit: unitName, branch: shiftBranch, clone });

    // --- 4. refuse the main clone -------------------------------------------
    if (isInside(clone, workdir)) {
      process.stderr.write(`yan shift new: the sub-agent would have started in ${workdir}\n`);
      process.stderr.write(`yan shift new: that is the main clone (${clone}), which yan only ever fetches into\n`);
      throw new YanError('shift_new_main_clone', "refusing to start a shift in the main clone - a shift works only in a leased worktree. The tree has been returned; check the pool's configuration before retrying",
        { exitCode: RC_MAIN_CLONE },
      );
    }
    if (isInside(clone, tree)) {
      throw new YanError('shift_new_main_clone', `refusing to start a shift: the pool handed out ${tree}, which is inside the main clone ${clone}`,
        { exitCode: RC_MAIN_CLONE },
      );
    }

    // --- 5. start the agent, and confirm it ---------------------------------
    // Filled in over the placeholder step 1 wrote; the pane follows
    // immediately afterwards, so a running agent is always recorded.
    const metaFile = join(shift.run, 'meta.json');
    let meta = metaFor({ task, sid, unit: unitName, data, shiftBranch, grant, clone, workdir, holder, spec, container });
    writeJson(metaFile, meta);

    // The first words the shift sees, so the skills are invoked before the
    // brief can pull it into the work.
    const invoke = spec.skills.length === 0 ? '' : `First invoke ${spec.skills.map((s) => `/${s}`).join(', ')}; if one is not available, carry on without it. Then `;
    const prompt = `${invoke}${invoke === '' ? 'Read' : 'read'} ${join(shift.dir, 'brief.md')} and do what it says. It is your whole work order.`;
    const startedAgent = terminal.startAgent({
      container,
      ...(split === undefined ? {} : { split }),
      name: agentNameFor(sid, unitName),
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
      argv: harnessArgv(spec, workdir, addDirs, prompt),
      // Typed in once the harness is idle; agy already has it in argv.
      ...(cliKind(agent) === 'agy' ? {} : { prompt }),
    });
    started = true;

    meta = {
      ...meta,
      pane: startedAgent.pane,
      status: startedAgent.status,
      ...(startedAgent.agent_session === undefined ? {} : { agent_session: startedAgent.agent_session }),
    };
    writeJson(metaFile, meta);

    if (startedAgent.status === 'blocked') {
      process.stderr.write(`yan shift new: ${sid} started, but something yan does not recognise is waiting for an answer on ${startedAgent.pane} - 'yan state ${sid}' and the pane itself say what. The tree is held and the shift is running\n`,
      );
    }

    display('could not title the shift pane', () => {
      terminal.setPaneTitle(startedAgent.pane, `${sid}-${unitName} · unit=${unitName}`, 'yan:shift');
    });

    appendLog('yan shift new', task, 'started', `${sid} ${unitName}  dispatched on ${shiftBranch} as ${spec.scenario}/${spec.tier} (${runsAs(spec)} in ${workdir})`, note);

    return meta;
  } finally {
    if (!started) {
      if (grant !== undefined) {
        // The lease id goes with it, so a slot somebody else now holds is
        // refused rather than wiped.
        const back = returnLease(clone, grant.path, { leaseId: grant.lease_id, holder }, deps.pool);
        if (!back.returned) {
          process.stderr.write(`yan shift new: the tree at ${grant.path} could not be returned - 'yan tree status --repo ${data.repo}' shows the lease\n`,
          );
        }
      }
      // Giving the sid back too, so the next dispatch reuses it rather than
      // leaving a hole where a shift never ran.
      rmSync(shift.dir, { recursive: true, force: true });
    }
  }
}

export const newShift = new Command('new')
  .description('dispatch a shift')
  .option('--unit <name>', 'which unit of the task this shift works on')
  .option('--sid <sid>', 'the shift id; derived as the next free s<n> when omitted')
  .option('--scenario <name>', 'REQUIRED: explore | coding | uix - the kind of work')
  .option('--tier <name>', "one of the scenario's tiers in config.json; defaults to its default")
  .option('--brief <file>', 'a file whose contents become the body of the work order')
  .option('--brief-text <text>', 'the work order, inline')
  .option('--note <text>', 'one line for log.md: what this shift is for')
  .option('--json', 'print the dispatch record instead of a summary')
  .addHelpText(
    'after',
    `
The shift branch is always yan/<task>-<unit>-<sid> and is never derived from
the integration branch's name. The integration branch is pushed to origin
first when it is not there yet, so the shift's merge request has a base.

Exit codes: 3 the pool is full, 4 the working directory would have been the
main clone and the dispatch was refused.`,
  )
  .action(
    action('yan shift new', (options: NewOptions) => {
      const meta = dispatch(options);
      if (options.json === true) {
        out(JSON.stringify(meta, null, 2));
        return;
      }
      out(`${meta.sid}  ${meta.unit}`);
      out(`branch   ${meta.branch} (from ${meta.base})`);
      out(`tree     ${meta.tree}`);
      out(`workdir  ${meta.workdir}`);
      out(`agent    ${meta.scenario}/${meta.tier}: ${runsAs({ cli: meta.agent ?? '', model: meta.model ?? '', effort: meta.effort ?? '', skills: meta.skills })}  (${meta.pane} in container ${meta.container})`);
      out(`brief    ${join(new Shift(meta.task ?? '', meta.sid ?? '').dir, 'brief.md')}`);
    }),
  );
