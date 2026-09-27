import { nativePath } from '../../util/paths.js';
import { herdrCall, mapError, resultOf, runHerdr, type HerdrRunner } from './cli.js';
import { isPaneId, paneIsIn, requirePaneId, requireWorkspaceId } from './ids.js';
import { asRecord, asString, recordOrNone } from '../../util/narrow.js';
import { agentSessionOf, statusOf } from './parse.js';
import { BUSY_RETRY_MS, SETTLE_MS, startAgent, type Starting } from './start.js';
import { YanError } from '../../util/error.js';
import type {
  AgentStatus,
  StartAgentOptions,
  Alive,
  Container,
  ListedAgent,
  ReadFormat,
  ReadSource,
  StartedAgent,
  TabLayout,
} from './types.js';

/**
 * Every Herdr command yan runs lives behind one of these methods. A task's
 * container is a workspace (`w1`) and one agent is a pane (`w1:p1`).
 *
 * Everything is addressed by id, never by label or `--current`: a name is
 * cleared when its agent exits, which is when yan most needs to identify it.
 * Nothing here closes a workspace or a tab — the one pane closed is either
 * named by its caller or the pane `startAgent` just made, by a new tab or a
 * split, and could not start its agent in — and nothing here focuses, since
 * focusing a pane marks it seen and changes what `agent get` reports about it.
 *
 * Answers are read in the one shape protocol 22 gives, checked against
 * `herdr api schema --json` and a live herdr 0.9.0: an id sits inside the
 * object it names (`result.pane.pane_id`, `result.root_pane.pane_id`), never
 * flat beside it.
 */
interface TerminalOptions {
  /** Defaults to the real `herdr`. */
  readonly run?: HerdrRunner;
  /**
   * How long `startAgent` waits for a freshly started agent to settle, in
   * milliseconds. 0 skips the wait, which is what a test with a fake herdr
   * wants.
   */
  readonly settleMs?: number;
  /**
   * How long `startAgent` keeps asking a new pane to take its agent
   * while herdr answers that the pane is not at its shell prompt yet, in
   * milliseconds.
   */
  readonly busyRetryMs?: number;
  /** Blocks for a number of milliseconds between those attempts. */
  readonly sleep?: (ms: number) => void;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Terminal {
  private readonly run: HerdrRunner;
  private readonly starting: Starting;

  public constructor(options: TerminalOptions = {}) {
    this.run = options.run ?? runHerdr;
    this.starting = {
      run: this.run,
      sleep: options.sleep ?? sleepMs,
      settleMs: options.settleMs ?? SETTLE_MS,
      busyRetryMs: options.busyRetryMs ?? BUSY_RETRY_MS,
      status: (pane) => this.statusOrUnknown(pane),
      alive: (pane) => this.agentAlive(pane),
      screen: (pane) => this.readOrEmpty(pane),
      send: (pane, text) => this.send(pane, text),
    };
  }

  /**
   * Run a herdr command and return its parsed `.result`.
   *
   * @throws YanError when the command failed.
   */
  private call(args: readonly string[], what: string): unknown {
    return herdrCall(this.run, args, what);
  }

  /**
   * Ask herdr something whose answer is allowed to be missing: its `.result`
   * as a record, or `undefined` when the command failed or said nothing
   * readable. Never throws; each caller decides what not knowing means.
   */
  private query(args: readonly string[]): Record<string, unknown> | undefined {
    const result = this.run(args);
    return result.code === 0 ? recordOrNone(resultOf(result.stdout)) : undefined;
  }

  /** Create a workspace to hold a task's agents. Does not focus it. */
  public createContainer(label: string, cwd?: string): Container {
    if (label === '') throw YanError.usage('term_usage', 'a container label is required');
    const args = ['workspace', 'create', '--label', label, '--no-focus'];
    if (cwd !== undefined && cwd !== '') args.push('--cwd', nativePath(cwd));

    const result = asRecord(this.call(args, 'workspace create'));
    return {
      workspace: asString(asRecord(result.workspace).workspace_id),
      tab: asString(asRecord(result.tab).tab_id),
      pane: asString(asRecord(result.root_pane).pane_id),
    };
  }

  /**
   * Start an agent in a new tab of `options.container`, or in the new half of
   * `options.split`, and answer once it has settled. `start.ts` has the whole
   * lifecycle and what each step guards against.
   *
   * @throws YanError `term_usage` for a missing argument, `term_not_found` when no
   *   agent is in the pane afterwards.
   */
  public startAgent(options: StartAgentOptions): StartedAgent {
    return startAgent(this.starting, options);
  }

  /**
   * What Herdr says the agent in this pane is doing: `blocked` is an approval
   * or a question on its screen, `done` is unseen work that finished, and
   * `unknown` is Herdr declining to say — never a verdict about the shift.
   *
   * @throws YanError `term_usage` when `pane` is not a pane id.
   */
  public agentStatus(pane: string): AgentStatus {
    requirePaneId(pane, 'agentStatus');
    return this.statusOrUnknown(pane);
  }

  /** The agent's status, or `unknown` when Herdr will not say. */
  private statusOrUnknown(pane: string): AgentStatus {
    const body = this.query(['agent', 'get', pane]);
    return body === undefined ? 'unknown' : statusOf(asRecord(body.agent).agent_status);
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
   * Send one prompt: text and Enter in a single submission.
   *
   * Checks for a live agent first, so text is never typed into a shell that
   * would run it. Liveness is screen-based, so it catches a pane whose agent
   * is visibly gone and cannot promise more.
   *
   * @throws YanError `term_usage` for an empty pane or text, `term_not_found` when
   *   no live agent is there.
   */
  public send(pane: string, text: string): void {
    requirePaneId(pane, 'send');
    if (text === '') throw YanError.usage('term_usage', 'there is nothing to send');
    if (this.agentAlive(pane) !== 'alive') {
      throw new YanError('term_not_found',
        `no live agent in ${pane} - refusing to send, because the text would be typed into whatever shell is there`,
      );
    }
    this.call(['agent', 'prompt', pane, text], 'agent prompt');
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
   * none. Does not mark the pane seen.
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
  public read(pane: string, lines = 80, source: ReadSource = 'recent_unwrapped', format: ReadFormat = 'text'): string {
    requirePaneId(pane, 'read');
    if (!Number.isInteger(lines) || lines <= 0) {
      throw YanError.usage('term_usage', `a whole number of lines is required, got '${lines}'`);
    }
    const args = ['agent', 'read', pane, '--source', source, '--lines', String(lines)];
    if (format === 'ansi') args.push('--format', 'ansi');
    const result = this.run(args);
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
   * Which harness Herdr sees in this pane — `claude`, `codex`, … as Herdr
   * spells them — or `undefined` when it will not say.
   *
   * @throws YanError `term_usage` when `pane` is not a pane id.
   */
  public agentKind(pane: string): string | undefined {
    requirePaneId(pane, 'agentKind');
    const kind = asString(asRecord(this.query(['agent', 'get', pane])?.agent).agent);
    return kind === '' ? undefined : kind;
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
    const body = asRecord(this.query(['pane', 'get', pane]));
    const id = asString(asRecord(body.pane).workspace_id);
    return id === '' ? undefined : id;
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

    const body = asRecord(this.call(['agent', 'list'], 'agent list'));
    const raw = Array.isArray(body.agents) ? body.agents : [];

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
   * The panes of the tab `pane` is in, and where each sits. `undefined` when
   * Herdr cannot say, never a throw: a caller without a layout does what it
   * did before there was one.
   */
  public tabLayout(pane: string): TabLayout | undefined {
    if (!isPaneId(pane)) return undefined;
    const layout = asRecord(this.query(['pane', 'layout', '--pane', pane])?.layout);
    if (!Array.isArray(layout.panes)) return undefined;
    const panes = [];
    for (const entry of layout.panes) {
      const listed = asRecord(entry);
      const id = asString(listed.pane_id);
      const rect = asRecord(listed.rect);
      const [x, y, width, height] = [rect.x, rect.y, rect.width, rect.height];
      if (id === '' || typeof x !== 'number' || typeof y !== 'number' ||
          typeof width !== 'number' || typeof height !== 'number') return undefined;
      panes.push({ pane: id, rect: { x, y, width, height } });
    }
    return { workspace: asString(layout.workspace_id), tab: asString(layout.tab_id), panes };
  }
}
