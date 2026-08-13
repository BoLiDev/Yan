import { TerminalError } from './errors.js';
import { nativePath } from '../../util/paths.js';
import { herdrCall, mapError, runHerdr, type HerdrRunner } from './cli.js';
import { isPaneId, paneIsIn, requireAgentName, requirePaneId, requireWorkspaceId } from './ids.js';
import { agentSessionOf, asRecord, statusOf, str } from './parse.js';
import type {
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
 * Nothing here closes a workspace or a tab, and nothing here focuses — a
 * focused tab is marked seen, which turns a `done` yan would be woken by into
 * an `idle` it ignores.
 */
export interface TerminalOptions {
  /** Defaults to the real `herdr`. */
  readonly run?: HerdrRunner;
}

export class Terminal {
  private readonly run: HerdrRunner;

  public constructor(options: TerminalOptions = {}) {
    this.run = options.run ?? runHerdr;
  }

  /**
   * Run a herdr command and return its parsed `.result`.
   *
   * @throws TerminalError when the command failed.
   */
  private call(args: readonly string[], what: string): unknown {
    return herdrCall(this.run, args, what);
  }

  /** Create a workspace to hold a task's agents. Does not focus it. */
  public createContainer(label: string, cwd?: string): Container {
    if (label === '') throw TerminalError.usage('a container label is required');
    const args = ['workspace', 'create', '--label', label, '--no-focus'];
    if (cwd !== undefined && cwd !== '') args.push('--cwd', nativePath(cwd));

    const result = asRecord(this.call(args, 'workspace create'));
    const workspace = asRecord(result.workspace);
    return {
      workspace: str(workspace.workspace_id) || str(result.workspace_id),
      tab: str(asRecord(result.tab).tab_id) || str(result.tab_id),
      pane: str(asRecord(result.root_pane).pane_id) || str(result.root_pane_id),
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
   * @throws TerminalError `usage` for a missing argument, `notFound` when no
   *   agent is in the pane afterwards.
   */
  public startAgent(options: StartAgentOptions): StartedAgent {
    requireAgentName(options.name);
    if (options.kind === '') throw TerminalError.usage('an agent kind is required');
    if (options.cwd === '') throw TerminalError.usage('a working directory is required');

    const pane = this.createTab(options);
    const startArgs = ['agent', 'start', options.name, '--kind', options.kind, '--pane', pane];
    if (options.timeoutMs !== undefined) startArgs.push('--timeout', String(options.timeoutMs));
    // Everything after `--` reaches the agent as argv, with no shell in
    // between, so nothing here needs quoting.
    if (options.argv !== undefined && options.argv.length > 0) startArgs.push('--', ...options.argv);

    const started = asRecord(this.call(startArgs, 'agent start'));
    const agent = asRecord(started.agent);
    const reported = str(agent.pane_id) || pane;

    if (this.agentAlive(reported) !== 'alive') {
      throw new TerminalError(
        'notFound',
        `herdr reported '${options.name}' ready in ${reported}, but no agent is there - the CLI probably exited at once. Look at the pane before sending anything to it`,
      );
    }

    const session = agentSessionOf(agent.agent_session);
    return {
      name: str(agent.name) || options.name,
      pane: reported,
      status: statusOf(agent.agent_status),
      ...(session === undefined ? {} : { agent_session: session }),
    };
  }

  /**
   * Send one prompt: text and Enter in a single submission. `waitMs` waits for
   * the agent to finish, up to that many milliseconds.
   *
   * Checks for a live agent first, so text is never typed into a shell that
   * would run it. Liveness is screen-based, so it catches a pane whose agent
   * is visibly gone and cannot promise more.
   *
   * @throws TerminalError `usage` for an empty pane or text, `notFound` when
   *   no live agent is there.
   */
  public send(pane: string, text: string, waitMs?: number): void {
    requirePaneId(pane, 'send');
    if (text === '') throw TerminalError.usage('there is nothing to send');
    if (this.agentAlive(pane) !== 'alive') {
      throw new TerminalError(
        'notFound',
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
   */
  public read(pane: string, lines = 80, source: ReadSource = 'recent-unwrapped'): string {
    requirePaneId(pane, 'read');
    if (!Number.isInteger(lines) || lines <= 0) {
      throw TerminalError.usage(`a whole number of lines is required, got '${lines}'`);
    }
    const body = asRecord(
      this.call(['agent', 'read', pane, '--source', source, '--lines', String(lines)], 'agent read'),
    );
    if (typeof body.text === 'string') return body.text;
    if (Array.isArray(body.lines)) return body.lines.map((l) => str(l)).join('\n');
    return '';
  }

  /**
   * alive | dead | unknown. A closed pane is `dead`; a Herdr that cannot be
   * reached is `unknown`, never `dead`.
   */
  public agentAlive(pane: string): Alive {
    requirePaneId(pane, 'agentAlive');

    const agent = this.run(['agent', 'get', pane]);
    if (agent.code === 0) return 'alive';
    if (mapError(agent, 'agent get').code !== TerminalError.codes.notFound) return 'unknown';

    const paneResult = this.run(['pane', 'get', pane]);
    if (paneResult.code === 0) return 'dead';
    return mapError(paneResult, 'pane get').code === TerminalError.codes.notFound ? 'dead' : 'unknown';
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
      const id = str(asRecord(body.pane).workspace_id) || str(body.workspace_id);
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
      pane = str(asRecord(agent.agent).pane_id) || str(agent.pane_id);
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
      const pane = str(agent.pane_id);
      if (scoped && !paneIsIn(pane, container)) continue;
      const title = str(agent.terminal_title_stripped) || str(agent.terminal_title);
      const session = agentSessionOf(agent.agent_session);
      agents.push({
        name: str(agent.name),
        pane,
        status: statusOf(agent.agent_status),
        kind: str(agent.agent),
        ...(title === '' ? {} : { title }),
        ...(session === undefined ? {} : { agent_session: session }),
      });
    }
    return agents;
  }

  /**
   * Make a tab in the container and answer with its one pane.
   *
   * @throws TerminalError when the container is not a workspace id, or herdr
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
    const pane = str(asRecord(created.root_pane).pane_id) || str(created.root_pane_id);
    if (pane === '') throw TerminalError.usage('herdr did not report a root pane for the new tab');
    return pane;
  }
}
