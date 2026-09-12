import { nativePath } from '../../util/paths.js';
import { herdrCall, mapError, runHerdr, type HerdrRunner } from './cli.js';
import { isPaneId, paneIsIn, requireAgentName, requirePaneId, requireWorkspaceId } from './ids.js';
import { asRecord, asString } from '../../util/narrow.js';
import { agentSessionOf, statusOf } from './parse.js';
import { YanError, isYanError } from '../../util/error.js';
import type {
  AgentStatus,
  StartAgentOptions,
  Alive,
  Container,
  ListedAgent,
  ReadSource,
  StartedAgent,
} from './types.js';

/**
 * Every Herdr command yan runs lives behind one of these methods. A task's
 * container is a workspace (`w1`) and one agent is a pane (`w1:p1`).
 *
 * Everything is addressed by id, never by label or `--current`: a name is
 * cleared when its agent exits, which is when yan most needs to identify it.
 * Nothing here closes a workspace or a tab — the one pane closed is either
 * named by its caller or the root pane of a tab `startAgent` just made and
 * could not start its agent in — and nothing here focuses — a
 * focused tab is marked seen, which turns a `done` yan would be woken by into
 * an `idle` it ignores.
 */
export interface TerminalOptions {
  /** Defaults to the real `herdr`. */
  readonly run?: HerdrRunner;
  /**
   * How long `startAgent` waits for a freshly started agent to settle, in
   * milliseconds. 0 skips the wait, which is what a test with a fake herdr
   * wants.
   */
  readonly settleMs?: number;
  /**
   * How long `startAgent` keeps asking a new tab's pane to take its agent
   * while herdr answers that the pane is not at its shell prompt yet, in
   * milliseconds.
   */
  readonly busyRetryMs?: number;
  /** Blocks for a number of milliseconds between those attempts. */
  readonly sleep?: (ms: number) => void;
}

/** How long a new tab's shell is given to reach its prompt. */
const BUSY_RETRY_MS = 15000;

/** The pause between asking a busy pane again. */
const BUSY_INTERVAL_MS = 500;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How long a freshly started agent is given to reach `working` or `blocked`. */
const SETTLE_MS = 8000;

/** How many startup dialogs in a row `startAgent` will answer before giving up. */
const STARTUP_DIALOG_ROUNDS = 3;

/**
 * The dialogs a harness puts up before it has read its prompt, whose Enter
 * default answers the question yan already decided by choosing the directory
 * it started the agent in. Nothing else is answered blind: an unrecognised
 * question is left standing, for supervision to wake yan about.
 *
 * `--dangerously-skip-permissions` does not cover this one; it is asked before
 * permissions are consulted at all, and it is asked once per directory that
 * has no trusted ancestor.
 */
const STARTUP_DIALOGS: readonly RegExp[] = [/Yes, I trust this folder/i];

function isStartupDialog(screen: string): boolean {
  return STARTUP_DIALOGS.some((pattern) => pattern.test(screen));
}

export class Terminal {
  private readonly run: HerdrRunner;
  private readonly settleMs: number;
  private readonly busyRetryMs: number;
  private readonly sleep: (ms: number) => void;

  public constructor(options: TerminalOptions = {}) {
    this.run = options.run ?? runHerdr;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.busyRetryMs = options.busyRetryMs ?? BUSY_RETRY_MS;
    this.sleep = options.sleep ?? sleepMs;
  }

  /**
   * Run a herdr command and return its parsed `.result`.
   *
   * @throws YanError when the command failed.
   */
  private call(args: readonly string[], what: string): unknown {
    return herdrCall(this.run, args, what);
  }

  /** Create a workspace to hold a task's agents. Does not focus it. */
  public createContainer(label: string, cwd?: string): Container {
    if (label === '') throw YanError.usage('term_usage', 'a container label is required');
    const args = ['workspace', 'create', '--label', label, '--no-focus'];
    if (cwd !== undefined && cwd !== '') args.push('--cwd', nativePath(cwd));

    const result = asRecord(this.call(args, 'workspace create'));
    const workspace = asRecord(result.workspace);
    return {
      workspace: asString(workspace.workspace_id) || asString(result.workspace_id),
      tab: asString(asRecord(result.tab).tab_id) || asString(result.tab_id),
      pane: asString(asRecord(result.root_pane).pane_id) || asString(result.root_pane_id),
    };
  }

  /**
   * Create a tab in the container, carrying `env` and `cwd`, and start an
   * agent in its pane. Does not focus.
   *
   * Only returns a pane whose agent was still alive a moment later — Herdr's
   * own readiness check is screen-based and matches a bare shell prompt too.
   * That second look can be fooled the same way, so it catches an agent that
   * is already visibly gone and promises nothing beyond that.
   *
   * Herdr calls an agent ready as soon as it recognises one, which it does
   * while the harness is still holding up its trust dialog; the returned
   * `status` is therefore the settled one, read after the agent has had time
   * to move, and a recognised startup dialog has been answered by then. A
   * `blocked` here means something yan does not recognise is on the screen —
   * the agent is running, so the caller keeps the tree and lets supervision
   * wake `user`.
   *
   * @throws YanError `usage` for a missing argument, `notFound` when no
   *   agent is in the pane afterwards.
   */
  public startAgent(options: StartAgentOptions): StartedAgent {
    requireAgentName(options.name);
    if (options.kind === '') throw YanError.usage('term_usage', 'an agent kind is required');
    if (options.cwd === '') throw YanError.usage('term_usage', 'a working directory is required');

    const pane = this.createTab(options);
    const startArgs = ['agent', 'start', options.name, '--kind', options.kind, '--pane', pane];
    if (options.timeoutMs !== undefined) startArgs.push('--timeout', String(options.timeoutMs));
    // Everything after `--` reaches the agent as argv, with no shell in
    // between, so nothing here needs quoting.
    if (options.argv !== undefined && options.argv.length > 0) startArgs.push('--', ...options.argv);

    let started: Record<string, unknown>;
    try {
      started = asRecord(this.startWhenReady(startArgs));
    } catch (err) {
      // The pane came with the tab this call made, and it never took its
      // agent, so it is not left behind as an empty tab.
      try {
        this.call(['pane', 'close', pane], 'pane close');
      } catch {
        // Closing is tidying; the reason worth reporting is the start's.
      }
      throw err;
    }
    const agent = asRecord(started.agent);
    const reported = asString(agent.pane_id) || pane;

    if (this.agentAlive(reported) !== 'alive') {
      throw new YanError('term_not_found',
        `herdr reported '${options.name}' ready in ${reported}, but no agent is there - the CLI probably exited at once. Look at the pane before sending anything to it`,
      );
    }

    const session = agentSessionOf(agent.agent_session);
    return {
      name: asString(agent.name) || options.name,
      pane: reported,
      status: this.settle(reported, statusOf(agent.agent_status), options.prompt),
      ...(session === undefined ? {} : { agent_session: session }),
    };
  }

  /**
   * Wait for a freshly started agent to reach its input line, answering the
   * startup dialogs in `STARTUP_DIALOGS` as they appear, then hand it
   * `prompt` and answer with the status it settled on.
   *
   * The prompt is typed in here rather than passed on the command line
   * because Herdr's `agent start` returns only once the agent is ready for
   * input: one that already has its work order goes straight to work and is
   * still working at the deadline, so the start was reported as a timeout and
   * the pane closed on a shift that was fine. Typed in after the dialogs, the
   * prompt also survives a harness that restarts behind one, which drops
   * whatever it was started with.
   *
   * Never throws: the agent is already running, and every failure here is a
   * question about it rather than a reason to tear it down.
   */
  private settle(pane: string, reported: AgentStatus, prompt?: string): AgentStatus {
    if (this.settleMs <= 0) return this.handOver(pane, reported, prompt);

    let status = reported;
    let answered = false;
    for (let round = 0; round <= STARTUP_DIALOG_ROUNDS; round += 1) {
      // Returns the moment it is any of them, so a healthy agent costs a
      // second rather than the whole budget.
      this.waitFor(pane, ['idle', 'done', 'blocked']);
      status = this.statusOrUnknown(pane);

      if (status !== 'blocked') break;
      if (round === STARTUP_DIALOG_ROUNDS) break;
      if (!isStartupDialog(this.readOrEmpty(pane))) break;

      // Enter takes the highlighted default, which for these is yes.
      this.run(['agent', 'send-keys', pane, 'enter']);
      answered = true;
    }

    if (answered) {
      // The harness is restarting behind the dialog, and Herdr reads that
      // screen as `blocked` too, so the status just taken says nothing yet.
      this.waitFor(pane, ['idle', 'done']);
      status = this.statusOrUnknown(pane);
    }

    return this.handOver(pane, status, prompt);
  }

  /**
   * Type the work order into an agent that is at its input line. A `blocked`
   * agent is asking something nobody here recognises, and the prompt would be
   * typed into that dialog; it is left standing for supervision to raise.
   */
  private handOver(pane: string, status: AgentStatus, prompt?: string): AgentStatus {
    if (status === 'blocked' || prompt === undefined || prompt === '') return status;
    try {
      this.send(pane, prompt);
      return this.statusOrUnknown(pane);
    } catch {
      // The agent is up and the pane is recorded; supervision has it from here.
      return status;
    }
  }

  /**
   * `agent start`, asked again while herdr says the pane is busy. A new tab's
   * shell takes a moment to reach its prompt, and herdr is the one that knows
   * when it has; nothing was started while it said busy, so asking again
   * cannot start a second agent.
   *
   * @throws YanError `busy` once `busyRetryMs` has passed, or whatever
   *   else the start fails with, at once.
   */
  private startWhenReady(args: readonly string[]): unknown {
    const deadline = Date.now() + this.busyRetryMs;
    for (;;) {
      try {
        return this.call(args, 'agent start');
      } catch (err) {
        if (!(isYanError(err)) || err.code !== 'term_busy') throw err;
        if (Date.now() + BUSY_INTERVAL_MS > deadline) {
          throw new YanError('term_busy', `the new pane was not at its shell prompt within ${Math.round(this.busyRetryMs / 1000)}s, so no agent was started in it`, { cause: err });
        }
        this.sleep(BUSY_INTERVAL_MS);
      }
    }
  }

  /** Wait for any of `states`, and answer nothing: the caller re-reads. */
  private waitFor(pane: string, states: readonly AgentStatus[]): void {
    const args = ['agent', 'wait', pane];
    for (const state of states) args.push('--until', state);
    args.push('--timeout', String(this.settleMs));
    this.run(args);
  }

  /**
   * What Herdr says the agent in this pane is doing: `blocked` is an approval
   * or a question on its screen, `done` is unseen work that finished, and
   * `unknown` is Herdr declining to say — never a verdict about the shift.
   *
   * @throws YanError `usage` when `pane` is not a pane id.
   */
  public agentStatus(pane: string): AgentStatus {
    requirePaneId(pane, 'agentStatus');
    return this.statusOrUnknown(pane);
  }

  /** The agent's status, or `unknown` when Herdr will not say. */
  private statusOrUnknown(pane: string): AgentStatus {
    const result = this.run(['agent', 'get', pane]);
    if (result.code !== 0) return 'unknown';
    try {
      const body = asRecord(asRecord(JSON.parse(result.stdout)).result);
      return statusOf(asRecord(body.agent).agent_status);
    } catch {
      return 'unknown';
    }
  }

  /** The screen, or `''` when it cannot be read. */
  private readOrEmpty(pane: string): string {
    try {
      return this.read(pane, 60, 'detection');
    } catch {
      return '';
    }
  }

  /**
   * Send one prompt: text and Enter in a single submission. `waitMs` waits for
   * the agent to finish, up to that many milliseconds.
   *
   * Checks for a live agent first, so text is never typed into a shell that
   * would run it. Liveness is screen-based, so it catches a pane whose agent
   * is visibly gone and cannot promise more.
   *
   * @throws YanError `usage` for an empty pane or text, `notFound` when
   *   no live agent is there.
   */
  public send(pane: string, text: string, waitMs?: number): void {
    requirePaneId(pane, 'send');
    if (text === '') throw YanError.usage('term_usage', 'there is nothing to send');
    if (this.agentAlive(pane) !== 'alive') {
      throw new YanError('term_not_found',
        `no live agent in ${pane} - refusing to send, because the text would be typed into whatever shell is there`,
      );
    }
    const args = ['agent', 'prompt', pane, text];
    if (waitMs !== undefined) args.push('--wait', '--timeout', String(waitMs));
    this.call(args, 'agent prompt');
  }

  /**
   * Report display tokens for a workspace under the source `yan`, so they
   * never collide with another tool's and can be withdrawn as a set. `ttlMs`
   * expires them, so a yan that dies leaves no stale ones.
   *
   * Display only: nothing set here is ever read back as a fact.
   */
  public setWorkspaceTokens(
    workspace: string,
    tokens: Readonly<Record<string, string>>,
    ttlMs?: number,
  ): void {
    requireWorkspaceId(workspace, 'workspace report-metadata');
    const args = ['workspace', 'report-metadata', workspace, '--source', 'yan'];
    for (const [key, value] of Object.entries(tokens)) args.push('--token', `${key}=${value}`);
    if (ttlMs !== undefined) args.push('--ttl-ms', String(ttlMs));
    this.call(args, 'workspace report-metadata');
  }

  /** Withdraw named tokens. An empty list is a no-op. */
  public clearWorkspaceTokens(workspace: string, names: readonly string[]): void {
    requireWorkspaceId(workspace, 'workspace report-metadata');
    if (names.length === 0) return;
    const args = ['workspace', 'report-metadata', workspace, '--source', 'yan'];
    for (const name of names) args.push('--clear-token', name);
    this.call(args, 'workspace report-metadata');
  }

  /** Report a pane's title under the source `yan`. Display only. */
  public setPaneTitle(pane: string, title: string, displayAgent?: string): void {
    requirePaneId(pane, 'pane report-metadata');
    const args = ['pane', 'report-metadata', pane, '--source', 'yan', '--title', title];
    if (displayAgent !== undefined && displayAgent !== '') {
      args.push('--display-agent', displayAgent);
    }
    this.call(args, 'pane report-metadata');
  }

  /** Withdraw the title yan set. */
  public clearPaneTitle(pane: string): void {
    requirePaneId(pane, 'pane report-metadata');
    this.call(['pane', 'report-metadata', pane, '--source', 'yan', '--clear-title'], 'pane report-metadata');
  }

  /**
   * The last `lines` lines of an agent's terminal, or `''` when Herdr reports
   * none. Does not mark the tab seen.
   *
   * The one command whose answer is the screen itself rather than JSON, so it
   * does not go through `call`: putting it there returned `''` for every
   * successful read, because a screen does not parse as JSON. A body that does
   * parse is still unwrapped, so a Herdr that starts wrapping it is read too.
   *
   * `source` is spelled as the API schema spells it; `herdr agent read` takes
   * that and the kebab-case form its --help lists, so the generated names go
   * through unchanged.
   *
   * @throws YanError when the command failed.
   */
  public read(pane: string, lines = 80, source: ReadSource = 'recent_unwrapped'): string {
    requirePaneId(pane, 'read');
    if (!Number.isInteger(lines) || lines <= 0) {
      throw YanError.usage('term_usage', `a whole number of lines is required, got '${lines}'`);
    }
    const result = this.run(['agent', 'read', pane, '--source', source, '--lines', String(lines)]);
    if (result.code !== 0) throw mapError(result, 'agent read');

    const raw = result.stdout;
    if (!raw.trimStart().startsWith('{')) return raw;
    try {
      const body = asRecord(asRecord(JSON.parse(raw)).result ?? JSON.parse(raw));
      if (typeof body.text === 'string') return body.text;
      if (Array.isArray(body.lines)) return body.lines.map((l) => asString(l)).join('\n');
      return raw;
    } catch {
      return raw;
    }
  }

  /**
   * alive | dead | unknown. A closed pane is `dead`; a Herdr that cannot be
   * reached is `unknown`, never `dead`.
   */
  public agentAlive(pane: string): Alive {
    requirePaneId(pane, 'agentAlive');

    const agent = this.run(['agent', 'get', pane]);
    if (agent.code === 0) return 'alive';
    if (mapError(agent, 'agent get').code !== 'term_not_found') return 'unknown';

    const paneResult = this.run(['pane', 'get', pane]);
    if (paneResult.code === 0) return 'dead';
    return mapError(paneResult, 'pane get').code === 'term_not_found' ? 'dead' : 'unknown';
  }

  /**
   * Which workspace a pane belongs to — asked, not read off the id's prefix,
   * which a moved pane keeps. `undefined` when Herdr cannot say, never a
   * throw.
   */
  public workspaceOfPane(pane: string): string | undefined {
    if (!isPaneId(pane)) return undefined;
    const result = this.run(['pane', 'get', pane]);
    if (result.code !== 0) return undefined;
    try {
      const body = asRecord(asRecord(JSON.parse(result.stdout)).result);
      const id = asString(asRecord(body.pane).workspace_id) || asString(body.workspace_id);
      return id === '' ? undefined : id;
    } catch {
      return undefined;
    }
  }

  /**
   * The pane an agent is in now, when that differs from `recordedPane` —
   * moving a pane between workspaces changes its id. `undefined` when the
   * agent cannot be found or has not moved. Records nothing.
   */
  public reconcile(name: string, recordedPane: string): string | undefined {
    requireAgentName(name);
    const byName = this.run(['agent', 'get', name]);
    if (byName.code !== 0) return undefined;
    let pane = '';
    try {
      const agent = asRecord(asRecord(JSON.parse(byName.stdout)).result);
      pane = asString(asRecord(agent.agent).pane_id) || asString(agent.pane_id);
    } catch {
      return undefined;
    }
    return pane !== '' && pane !== recordedPane ? pane : undefined;
  }

  /**
   * Close one pane. Closing a tab's last pane removes the tab; the workspace
   * is never touched.
   */
  public close(pane: string): void {
    requirePaneId(pane, 'close');
    this.call(['pane', 'close', pane], 'pane close');
  }

  /**
   * The agents Herdr knows about, with their pane ids, states and session
   * ids. `container` filters to the panes whose id carries that workspace.
   */
  public list(container?: string): ListedAgent[] {
    const scoped = container !== undefined && container !== '';
    if (scoped) requireWorkspaceId(container, 'list');

    const result = this.call(['agent', 'list'], 'agent list');
    const body = asRecord(result);
    const raw = Array.isArray(body.agents) ? body.agents : Array.isArray(result) ? result : [];

    const agents: ListedAgent[] = [];
    for (const entry of raw) {
      const agent = asRecord(entry);
      const pane = asString(agent.pane_id);
      if (scoped && !paneIsIn(pane, container)) continue;
      const title = asString(agent.terminal_title_stripped) || asString(agent.terminal_title);
      const session = agentSessionOf(agent.agent_session);
      agents.push({
        name: asString(agent.name),
        pane,
        status: statusOf(agent.agent_status),
        kind: asString(agent.agent),
        ...(title === '' ? {} : { title }),
        ...(session === undefined ? {} : { agent_session: session }),
      });
    }
    return agents;
  }

  /**
   * Make a tab in the container and answer with its one pane.
   *
   * @throws YanError when the container is not a workspace id, or herdr
   *   reports no root pane.
   */
  private createTab(options: StartAgentOptions): string {
    requireWorkspaceId(options.container, 'tab create');
    const args = [
      'tab',
      'create',
      '--workspace',
      options.container,
      '--no-focus',
      '--cwd',
      nativePath(options.cwd),
    ];
    if (options.label !== undefined && options.label !== '') {
      args.push('--label', options.label);
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('--env', `${key}=${value}`);
    }

    const created = asRecord(this.call(args, 'tab create'));
    const pane = asString(asRecord(created.root_pane).pane_id) || asString(created.root_pane_id);
    if (pane === '') throw YanError.usage('term_usage', 'herdr did not report a root pane for the new tab');
    return pane;
  }
}
