import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { cliKind, modelFlags, resolveShift, runsAs, type ShiftSpec } from './shared/config.js';
import { resolveContainer } from './shared/container.js';
import { display } from './shared/display.js';
import { noted, readNote } from './shared/note.js';
import { shiftAbandonCommand } from './abandon.js';
import { readLearnings } from './session-start.js';
import { poolSize, repoTarget } from './shared/repo.js';
import { insideTask } from './shared/task-id.js';
import { cloneOf, closePane, leasesHeldBy, returnLease } from './shared/teardown.js';
import type { Closer } from './shared/terminal.js';
import { Terminal, type AgentStatus } from '../externals/herdr/index.js';
import { RemoteGit, type MrState } from '../externals/remote-git/index.js';
import { WorktreePool, type LeaseGrant } from '../externals/worktree/index.js';
import { Log } from '../records/log/index.js';
import { opensMr, Shift, type ShiftMeta, type ShiftMetaPlaceholder } from '../records/shift/index.js';
import { Task, type UnitData } from '../records/task/index.js';
import { YanError, isYanError } from '../util/error.js';
import { yanHome } from '../util/home.js';
import { writeJson } from '../util/json.js';
import { withLock } from '../util/lock.js';
import { branchExists, deleteRemoteBranch, push, remoteBranchExists } from '../util/git.js';
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

/** How long a dispatch waits for the task's prologue lock. */
const DISPATCH_LOCK_SECONDS = 120;

/**
 * Claim `shifts/<sid>/` for this dispatch, and answer with the sid it got.
 * The directory is the claim: `mkdir` without `recursive` fails rather than
 * succeeding on one that is already there, so two dispatches racing for the
 * same `s<n>` cannot both walk away believing they hold it — which is how they
 * used to end up cutting the same shift branch.
 *
 * @throws YanError `usage` when an explicitly named sid is already taken.
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
 *
 * @returns what it found or did, for the caller to report.
 */
export function publishBase(clone: string, branch: string): 'on-origin' | 'pushed' | 'failed' | 'local-only' {
  if (remoteBranchExists(clone, branch)) return 'on-origin';
  if (!branchExists(clone, branch)) return 'local-only';

  const pushed = push(clone, ['-u', 'origin', branch]);
  if (pushed.code === 0) return 'pushed';
  process.stderr.write(`yan shift new: ${branch} is not on origin and could not be pushed (${pushed.stderr.trim()}) - the shift's merge request will have no base until it is\n`);
  return 'failed';
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

/** The learnings index as brief lines, each with a path a shift can open. */
function knownLearnings(): string[] {
  const learnings = readLearnings();
  if (learnings.length === 0) return [];
  return [
    '- What earlier work found out the hard way. When a problem matches one, read it before',
    '  working the problem out again:',
    ...learnings.map((l) => `      ${normalizePath(join(vaultDir(), l.path))} — ${l.name}${l.description === '' ? '' : `: ${l.description}`}`),
  ];
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
  skills: readonly string[];
  scenario: string;
}): string {
  const { sid, task, unit, data, tree, clone, branch, taskDir, skills } = options;
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
    `| scenario | ${options.scenario} |`,
    `| scope | ${data.scope.length > 0 ? data.scope.join(' ') : '(the whole repository)'} |`,
    '',
    ...(skills.length === 0
      ? []
      : [
          '## Skills',
          '',
          `Invoke ${skills.map((s) => `/${s}`).join(', ')} before anything else, and work the way ${skills.length === 1 ? 'it says' : 'they say'}.`,
          'If one is not available, carry on without it and say so in outcome.md.',
          '',
        ]),
    '## The work',
    '',
    options.work,
    '',
    '## What is already known',
    '',
    `- Research, designs and other by-products of this task are in ${taskDir}/artifacts;`,
    '  the work above names the ones that matter here.',
    ...knownLearnings(),
    '',
    '## How this shift works',
    '',
    `- Work only inside ${tree}. Never touch ${clone}: it is the main clone.`,
    `- You are on ${branch}, which was cut from ${data.branch}.${opensMr(options.scenario) ? ` Push it and open a merge request into ${data.branch}.` : ' It stays local: nothing is pushed.'}`,
    `- Run the project's install step first, every time. The tree may be warm from an`,
    '  earlier shift, in which case it finishes in seconds with nothing to do.',
    '- Artifacts go in $YAN_TASK_DIR/artifacts',
    `  (${taskDir}/artifacts), NEVER inside the worktree: the tree is wiped when it is`,
    '  returned, so anything left in it is destroyed or accidentally committed. An',
    '  artifact is a by-product that helps yan and user understand the work - research',
    '  findings, prototypes, designs, screenshots that show the result. The deliverable',
    '  itself is on your branch.',
    '- Throwaway state - build output, a browser profile, a scratch database, logs - is',
    '  not an artifact. Put it in the system temp directory, so it is neither committed',
    '  nor kept.',
    '- Before you report done, write $YAN_SHIFT_DIR/outcome.md',
    `  (${taskDir}/shifts/${sid}/outcome.md): the handover yan reads before it`,
    '  merges your work and decides what comes next. It is for yan, not for the reviewers',
    '  a merge request description is for, so say what the diff cannot:',
    '      Result        what changed, in behaviour, in a few sentences',
    '      Reading       where the brief was ambiguous or silent, and what you chose',
    '      Deviations    where you did not do what the brief said, and why',
    '      Learnings     problems you hit and how you solved them, above all what cost real time',
    '      Left over     what is unfinished, and problems you saw outside scope but did not touch',
    '      Verification  how you checked it, and what you could not check',
    '      Artifacts     what you left in $YAN_TASK_DIR/artifacts',
    '  Leave out a section with nothing in it. Do not restate the brief or walk the diff',
    '  file by file. If yan sends you more work after that, rewrite the file before you',
    '  report done again. `yan report done` refuses until the file exists.',
    '- Report only when yan has to act:',
    `      ${home}/bin/yan report <started|done|blocked|needs-decision|conflict> "<one line>"`,
  ];
  if (opensMr(options.scenario)) {
    lines.push(
      '  When you are done, the note must carry the merge request URL, because that',
      '  is how yan learns the address to ask the host about:',
      `      ${home}/bin/yan report done "mr <url>"`,
    );
  }
  lines.push(
    '- Reporting done does not end this shift. yan tries the work, and when it needs more of',
    '  the same - a fix, a change, another pass - it sends you the next round here, since',
    '  you already know the work. Stay until yan clocks you out.',
  );
  if (opensMr(options.scenario)) {
    lines.push(
      `  A new round starts from ${data.branch} as it now is: once yan says your last merge`,
      `  request merged, fetch and reset ${branch} onto origin/${data.branch} - what you had`,
      '  is already in it - then work, push, open a new merge request, rewrite outcome.md, and',
      '  report done with the new URL.',
    );
  } else {
    lines.push('  For a new round, do the work, rewrite outcome.md, and report done again.');
  }
  lines.push(
    '- A line from yan may name a file; read it, since it carries what did not fit in the line.',
    '- The scope in the table above is where this work belongs. Going outside it is not',
    "  forbidden, but it is not yours to decide quietly: report it, say what you need and",
    '  why, and let yan answer.',
  );
  if (options.scenario === 'explore') {
    lines.push(
      '- This is an explore shift: investigate and write it up. Build it, run it, break it if',
      '  that is what answering the question takes - the tree is thrown away. What you must',
      '  not do is leave anything behind: do not push, do not open a merge request. The',
      '  report goes in $YAN_TASK_DIR/artifacts and outcome.md, and that is the whole deliverable.',
    );
  } else if (options.scenario === 'uix') {
    lines.push(
      '- This is a uix shift: the deliverable is what you put in $YAN_TASK_DIR/artifacts -',
      '  designs, prototypes, visual proposals - and outcome.md describing it. Nothing is',
      '  pushed and no merge request is opened; user looks at the artifacts and accepts',
      '  them or asks for another round.',
    );
  }
  lines.push('- Do not talk to other shifts, and do not talk to user. Everything goes through yan.');
  return `${lines.join('\n')}\n`;
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
  startAgent(options: {
    container: string;
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
 * @throws YanError `usage` for a missing task, unit or agent, `pool_full`
 *   (exit 3) when no tree is free, `main_clone` (exit 4) when the agent would
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

  if (!Task.exists(task)) throw YanError.usage('shift_new_usage', `no such task: ${task}`);
  const record = new Task(task);
  const unit = record.findUnit(unitName);
  if (unit === undefined) {
    throw YanError.usage('shift_new_usage', `no such unit: ${unitName} in task ${task}`);
  }
  const data = unit.read();
  if (data.branch === '') {
    throw YanError.usage('shift_new_usage', `unit ${unitName} has no integration branch yet - 'yan unit add' or 'yan unit set --branch' sets one`,
    );
  }

  const { clone, key } = repoTarget('shift_new', data.repo, 'the unit names it, but nothing on this machine says where it is');

  // Before anything is claimed: the shift's merge request needs this branch on
  // origin to have a base, and pushing it is yan's to do.
  publishBase(clone, data.branch);

  const spec = resolveShift('shift_new', options.scenario, options.tier);
  const agent = spec.cli;

  const taskDir = record.dir;
  const terminal = deps.terminal ?? new Terminal();

  // --- 1. claim the sid and the container, one dispatch of this task at a
  // time ---------------------------------------------------------------------
  //
  // Both answers are read off what the task already has, so two dispatches
  // reading at once agree and then diverge: the same `s<n>`, and so the same
  // shift branch, and a container each because neither can see a shift the
  // other has not written down yet. The lock makes the read and the write one
  // step; the placeholder run/meta.json is the write, because a container is
  // found by asking this task's live shifts which one they are in.
  const claimed = withLock(join(taskDir, 'dispatch.lock'), DISPATCH_LOCK_SECONDS, () => {
    const sid = claimSid(task, options.sid);
    const shift = new Shift(task, sid);
    const container = resolveContainer(task, terminal, record.containerName());
    mkdirSync(shift.run, { recursive: true });
    const placeholder: ShiftMetaPlaceholder = { version: 1, task, sid, unit: unitName, container, pane: '' };
    writeJson(join(shift.run, 'meta.json'), placeholder);
    return { sid, shift, container };
  });
  const { sid, shift, container } = claimed;

  const branch = `yan/${task}-${unitName}-${sid}`;
  const holder = `${task}/${unitName}/${sid}`;

  // From here the shift directory is claimed, so every exit before an agent is
  // running gives it back along with the tree.
  let started = false;
  let grant: LeaseGrant | undefined;
  try {
    // --- 2. lease a tree, cutting the shift branch --------------------------
    const pool = deps.pool?.(clone) ?? new WorktreePool(clone);
    try {
      grant = pool.get(poolSize(key), data.branch, branch, holder);
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
      briefBody({ sid, task, unit: unitName, data, tree, clone, branch, taskDir, work, skills: spec.skills, scenario: spec.scenario }),
    );

    // --- 3. refuse the main clone -------------------------------------------
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
    let meta: ShiftMeta = {
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
      agent,
      scenario: spec.scenario,
      skills: [...spec.skills],
      tier: spec.tier,
      model: spec.model,
      effort: spec.effort,
      container,
      pane: '',
      mr: '',
      at: new Date().toISOString().slice(0, 19) + 'Z',
    };
    writeJson(metaFile, meta);

    // The first words the shift sees, so the skills are invoked before the
    // brief can pull it into the work.
    const invoke = spec.skills.length === 0 ? '' : `First invoke ${spec.skills.map((s) => `/${s}`).join(', ')}; if one is not available, carry on without it. Then `;
    const prompt = `${invoke}${invoke === '' ? 'Read' : 'read'} ${join(shift.dir, 'brief.md')} and do what it says. It is your whole work order.`;
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

    try {
      new Log(task).append('started', noted(`${sid} ${unitName}  dispatched on ${branch} as ${spec.scenario}/${spec.tier} (${runsAs(spec)} in ${workdir})`, note));
    } catch { /* the shift is running; a missing log line is not worth failing for */ }

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

const newShift = new Command('new')
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
  note?: string;
  keepPane?: boolean;
  userAccepted?: boolean;
  /** A coding shift concluded that nothing needs merging; its outcome.md is the deliverable. */
  nothingToMerge?: boolean;
  json?: boolean;
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
  /** The last round's merge request, or '' for a scenario that opens none. */
  readonly mr: string;
  readonly mr_state: 'merged' | 'none';
  readonly scenario: string;
  readonly tree: string;
  readonly outcome_by: string;
  readonly run_removed: true;
  readonly tree_returned: boolean;
  readonly branch_deleted: boolean;
  /** False when the agent was still in its pane after the close; the pane is then named in `pane`. */
  readonly pane_closed: boolean;
  readonly pane: string;
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
  // The holders are built from task.json rather than parsed out of the lease:
  // which unit a tree belongs to is the document's answer, not a name's.
  const units = new Map(new Task(task).read().units.map((u) => [`${task}/${u.name}/${sid}`, u.name]));
  for (const lease of leasesHeldBy(task, deps.pool)) {
    const unit = units.get(lease.holder);
    if (unit === undefined) continue;
    return {
      unit,
      clone: lease.clone,
      path: lease.path,
      branch: lease.branch,
      holder: lease.holder,
      leaseId: lease.lease_id,
    };
  }
  return undefined;
}

/**
 * Clock a shift out, resuming an interrupted teardown when `run/` is already
 * gone but a tree is still leased.
 *
 * @throws YanError `usage` for a missing sid, an unknown outcome file, no
 *   recorded merge request, or a shift that has fully clocked out;
 *   `not_merged` (exit 4) when the host says it has not merged;
 *   `return_refused` when the tree could not go back, in which case the remote
 *   branch is left alone.
 */
export function clockOut(sid: string | undefined, options: DoneOptions, deps: DoneDeps = {}): DoneResult {
  if (sid === undefined || sid === '') {
    throw YanError.usage('shift_done_usage', 'a shift id is required');
  }
  if (options.outcome !== undefined && !existsSync(options.outcome)) {
    throw YanError.usage('shift_done_usage', `no such outcome file: ${options.outcome}`);
  }
  const note = readNote('shift_done', options.note);

  const shift = Shift.resolve(sid, options.task ?? '');
  const meta = shift.meta();

  let unit = meta.unit ?? '';
  let branch = meta.branch ?? '';
  let tree = meta.tree ?? '';
  let clone = meta.clone ?? '';
  let holder = meta.holder ?? '';
  let leaseId = meta.lease_id ?? '';
  let pane = meta.pane ?? '';
  // The shift opens its own MR, so the URL usually arrives on its `done` event.
  let mr = options.mr ?? meta.mr ?? shift.reportedMr() ?? '';

  let resuming = false;
  if (!shift.isLive()) {
    const resume = resumeFromPool(shift.task, shift.sid, deps);
    if (resume === undefined) {
      throw YanError.usage('shift_done_usage', `shift ${shift.label()} has already clocked out - run/ is gone, which is the fact that says so`,
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
    throw new YanError('shift_done_no_branch', `run/meta.json does not say which shift branch ${shift.label()} is on - it cannot be cleaned up automatically`,
    );
  }

  // The fallback for a shift dispatched before meta.json recorded the clone.
  if (clone === '') clone = cloneOf(shift.task, unit);

  const outcomeFile = join(shift.dir, 'outcome.md');
  let outcomeBy: string;

  const scenario = meta.scenario;
  // Merging is the floor for coding, not the definition of done - whether the
  // merged work is accepted is yan's and user's judgement - unless the shift
  // concluded that nothing needs merging, which user says with the flag.
  const needsMerge = opensMr(scenario) && options.nothingToMerge !== true;

  // Steps 1 to 4 already ran in the attempt that stopped, and the URL they
  // needed went with run/, so a resume starts at the tree return.
  if (!resuming) {
    // --- 0. accepted, and by whom -------------------------------------------
    // Clocking out is the statement that the work is accepted. Interface work
    // is accepted by user alone, so that is a flag rather than a judgement.
    if (scenario === 'uix' && options.userAccepted !== true) {
      throw new YanError('shift_done_needs_user', `${shift.label()} is uix work, and only user accepts it - nothing was clocked out. When they have said they are satisfied, re-run with --user-accepted`,
        { exitCode: RC_NOT_MERGED },
      );
    }

    // --- 1. is its last round merged? ---------------------------------------
    if (needsMerge) {
      if (mr === '') {
        throw YanError.usage('shift_done_usage', `no merge request recorded for ${shift.label()} - pass --mr <url>. Whether the work landed is the host's answer, and yan will not guess it from git history`,
        );
      }
      const dir = tree !== '' && existsSync(tree) ? tree : clone !== '' && existsSync(clone) ? clone : undefined;
      const ask = deps.mrStateOf ?? ((url: string, d: string | undefined) => new RemoteGit().mrState({ mr: url, dir: d }));
      const state = ask(mr, dir);
      if (state !== 'merged') {
        throw new YanError('shift_done_not_merged', `${mr} is '${state}', not merged - a shift clocks out once its last round's merge request has merged into the integration branch, and nothing sooner`,
          { exitCode: RC_NOT_MERGED },
        );
      }
    } else {
      // An explore or uix shift opens no merge request, and a coding shift
      // that had nothing to merge has none either; what it delivered is its
      // handover, and without one there is nothing to have accepted.
      mr = '';
      if (!existsSync(outcomeFile) && options.outcome === undefined) {
        throw new YanError('shift_done_no_outcome', `${shift.label()} is ${options.nothingToMerge === true ? 'a coding shift with nothing to merge' : `${scenario === 'uix' ? 'a' : 'an'} ${scenario} shift`} and has written no outcome.md - there is no deliverable to accept yet. Pass --outcome <file> if its report lives elsewhere`,
          { exitCode: RC_NOT_MERGED },
        );
      }
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
        const what = needsMerge
          ? `${mr} merged into the integration branch`
          : options.nothingToMerge === true ? 'nothing to merge, report accepted' : scenario === 'uix' ? 'artifacts accepted by user' : 'report accepted';
        new Log(shift.task).append('delivered', noted(`${shift.sid} ${unit}  ${what}`, note));
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
    const back = returnLease(clone, tree, { leaseId, holder }, deps.pool);
    if (!back.returned) {
      // Fatal: a refusal here means the commits may exist nowhere else, and
      // deleting the remote branch next would make that permanent.
      throw new YanError('shift_done_return_refused', `the tree at ${tree} could not be returned, so the remote branch ${branch} has NOT been deleted - investigate before anything else touches it (${back.reason ?? ''})`,
        { exitCode: isYanError(back.cause) ? back.cause.exitCode : 1, cause: back.cause },
      );
    }
    returned = back.path;
  }

  // --- 6. and only now, the remote shift branch -----------------------------
  let deleted = false;
  // Only a merge request's branch was ever pushed.
  if (needsMerge && clone !== '' && existsSync(clone)) {
    const drop =
      deps.deleteBranch ?? ((c: string, b: string) => deleteRemoteBranch(c, 'origin', b).code === 0);
    deleted = drop(clone, branch);
    if (!deleted) {
      process.stderr.write(`yan shift done: the remote branch ${branch} could not be deleted (it may already be gone) - the tree is back in the pool either way\n`,
      );
    }
  }

  // --- 7. the agent's pane, and then whether the agent really went ----------
  // Never fatal to the teardown, which is done by now; an agent still running
  // is reported as a failure of the command, because nobody else will notice.
  const paneClosed = options.keepPane === true ? true : closePane(pane, deps.terminal);

  return {
    version: 1,
    sid: shift.sid,
    task: shift.task,
    unit,
    branch,
    mr,
    mr_state: needsMerge ? 'merged' : 'none',
    scenario,
    tree: returned !== '' ? returned : tree,
    outcome_by: outcomeBy,
    run_removed: true,
    tree_returned: returned !== '',
    branch_deleted: deleted,
    pane_closed: paneClosed,
    pane,
  };
}

const doneShift = new Command('done')
  .description('clock a shift out once its work is accepted')
  .argument('[sid]')
  .option('--mr <url>', "the last round's merge request, when the shift reported none")
  .option('--outcome <file>', 'a file whose contents become outcome.md if the shift wrote none')
  .option('--note <text>', 'one line for log.md: what the accepted work changed')
  .option('--user-accepted', 'user has said they are satisfied - required for uix work')
  .option('--nothing-to-merge', 'a coding shift concluded that no change is needed; its outcome.md is accepted instead of a merge request')
  .option('--keep-pane', "leave the agent's pane open")
  .option('--json', 'print the teardown record instead of a summary')
  .addHelpText(
    'after',
    `
Running it says the shift's work is accepted: a shift carries on through as
many rounds of rework as that takes, and is clocked out once, at the end. uix
work is accepted by user alone, so it needs --user-accepted.

A coding shift clocks out once its last round's merge request has merged -
the floor, not the definition, of accepted - or with --nothing-to-merge when
it concluded that no change is needed, in the one order that survives a
squash merge:

  merged -> outcome.md -> the log line -> rm -rf run/ -> return the tree
    -> delete the remote shift branch -> close the pane

An explore or uix shift opens none, and needs its outcome.md instead. Whether
a request merged is asked of the host, never inferred from git ancestry.

Exit code 4 means nothing was clocked out yet: the merge request has not
merged, the report is missing, or user has not accepted uix work. Exit code 1
after a teardown means the agent was still in its pane after closing it.`,
  )
  .action(
    action('yan shift done', (sid: string | undefined, options: DoneOptions) => {
      const r = clockOut(sid, options);
      if (options.json === true) {
        out(JSON.stringify(r));
      } else {
        out(`${r.sid} clocked out`);
        if (r.mr_state === 'merged') out(`mr       ${r.mr} (merged)`);
        out(`outcome  ${join(new Shift(r.task, r.sid).dir, 'outcome.md')} (${r.outcome_by})`);
        out('run      removed');
        out(`tree     ${r.tree_returned ? r.tree : 'not returned'}`);
        if (r.mr_state === 'merged') out(`branch   ${r.branch} ${r.branch_deleted ? 'deleted on origin' : 'left on origin'}`);
      }
      if (!r.pane_closed) {
        process.stderr.write(`yan shift done: the agent in ${r.pane} was still running after its pane was closed - close ${r.pane} by hand\n`);
        process.exitCode = 1;
      }
    }),
  );

export const command = new Command('shift')
  .description('dispatch, clock out and abandon shifts')
  .addCommand(newShift)
  .addCommand(doneShift)
  .addCommand(shiftAbandonCommand);
