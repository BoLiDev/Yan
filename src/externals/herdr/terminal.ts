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
 * The terminal, on Herdr (terminal.md).
 *
 * One terminal container per task. The concepts line up like this:
 *
 *     the task container   ->  a workspace   (w1)
 *     one agent            ->  a pane        (w1:p1)
 *     a terminal           ->  a pane
 *
 * Every Herdr command in yan lives behind one of these methods.
 *
 * Four rules this class exists to hold. They are the tmux implementation's
 * four, unchanged — only the multiplexer moved:
 *
 *   1. A LABEL IS NOT A SOURCE OF TRUTH; RECORD THE ID. Herdr does enforce that
 *      an agent NAME is unique among LIVE agents, which tmux never promised —
 *      but a name is cleared when the agent exits, so it cannot identify a
 *      shift that has died, and identifying dead shifts is precisely what
 *      supervision does. So ids are still what is recorded and what is passed
 *      (terminal.md §3).
 *
 *   2. CLOSE EXACTLY ONE THING. `close` closes the recorded pane and nothing
 *      else. There is no code path here that can close a workspace or a tab —
 *      `workspace close` and `tab close` are simply not spelled anywhere in
 *      this file, and a test greps for them. Container lifetime belongs to
 *      `user`: yan never closes a workspace, a tab, or a pane it did not
 *      create.
 *
 *   3. DO NOT STEAL FOCUS. Every call that could move the user passes
 *      `--no-focus`. **And yan never calls `agent focus` on a shift's pane**,
 *      for a second reason that is easy to miss: focusing marks the tab SEEN,
 *      which turns the `done` yan was about to be woken by into an `idle` it
 *      will ignore (supervision.md §3). `read` does not mark it seen. That is a
 *      real footgun, so it is written here and not only in the design.
 *
 *   4. REPORT FACTS, DECIDE NOTHING. `agentAlive` answers with one of three
 *      words defined by yan — alive, dead, unknown — never with Herdr's
 *      vocabulary, and never with a guess dressed up as a fact.
 *
 * `--current` is never passed: it resolves through `HERDR_PANE_ID`, and a hook
 * may be handed a sanitised environment (terminal.md §3). Explicit ids only.
 *
 * What is NOT here any more, and why:
 *   - `winpty`. A native process in a Herdr pane gets a real console
 *     (evidence.md §3).
 *   - command quoting. `agent start … -- <argv>` takes an argv array, so there
 *     is no shell in between (evidence.md §2).
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

  /** Run a herdr command that must succeed, and return its parsed `.result`. */
  private call(args: readonly string[], what: string): unknown {
    return herdrCall(this.run, args, what);
  }

  /**
   * Create the task container.
   *
   * Only when `user` asks for a new workspace; normally yan joins the one it is
   * already in (cli-ux.md). `--no-focus` because creating a container must not
   * move whoever asked for it.
   */
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
   * Start an agent.
   *
   * TWO STEPS, and they are not interchangeable: `agent start` requires an
   * existing pane already at an interactive prompt and never creates layout
   * (terminal.md §2). So the pane is split first, with the environment and the
   * working directory, and the agent is started into it.
   *
   * `agent start` waits for Herdr to detect the agent before returning — but
   * that is NOT proof the agent is up. It reported `interactive_ready: true`
   * for a codex that had already exited, having matched the bare shell prompt
   * it left behind (evidence.md §11.7). So this asks again, and refuses rather
   * than handing back a pane with nothing in it.
   *
   * WHAT THIS DOES NOT DO: it is not a fix for that codex. Detection is
   * screen-based, so a second look a millisecond later can be wrong in exactly
   * the same way. It catches the case where the agent is already visibly gone,
   * which is cheap and worth having; why codex exits at once is still open, and
   * a guard is not an answer to it.
   */
  public startAgent(options: StartAgentOptions): StartedAgent {
    requireAgentName(options.name);
    if (options.kind === '') throw TerminalError.usage('an agent kind is required');
    if (options.cwd === '') throw TerminalError.usage('a working directory is required');

    const pane = this.split(options);
    const startArgs = ['agent', 'start', options.name, '--kind', options.kind, '--pane', pane];
    if (options.timeoutMs !== undefined) startArgs.push('--timeout', String(options.timeoutMs));
    // Everything after `--` reaches the agent as argv. No shell, so no quoting
    // layer: `--append-system-prompt "a b"` survives intact (evidence.md §2).
    if (options.argv !== undefined && options.argv.length > 0) startArgs.push('--', ...options.argv);

    const started = asRecord(this.call(startArgs, 'agent start'));
    const agent = asRecord(started.agent);
    const reported = str(agent.pane_id) || pane;

    // Anything but `alive` is a refusal. `agent start` has just succeeded, so
    // herdr is reachable this instant; an `unknown` one call later is not a
    // transport blip, it is something genuinely wrong.
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
   * Send one prompt.
   *
   * Atomic: text and Enter in one submission, honouring the pane's live
   * bracketed-paste mode. The MVP's `--no-enter` / `--enter` split existed
   * because tmux `send-keys` could not do that; there is nothing left for it to
   * do here.
   *
   * NOTHING IS SENT TO A PANE WITHOUT A LIVE AGENT. A prompt to a pane whose
   * agent has died is typed into the shell, which then tries to run it as a
   * command (evidence.md §11.7) — a brief pasted into PowerShell, one line at a
   * time. One extra call before each send is a cheap price; sends are not hot.
   *
   * The same caveat as `startAgent`: detection is screen-based, so this catches
   * a pane whose agent is visibly gone and cannot promise more than that.
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
   * Tell Herdr what a workspace is delivering (display.md §2).
   *
   * `--source yan` names the reporter, so yan's labels never collide with
   * another tool's and can be withdrawn as a set. `--ttl-ms` expires them, so a
   * yan that dies mid-task leaves labels that clean themselves up.
   *
   * DISPLAY ONLY. Nothing reported here is ever read back as a fact: task.json
   * remains the only record of which unit is on which branch, and a token that
   * goes stale is a cosmetic bug rather than a correctness one. Callers treat a
   * failure as one logged line, never as a reason to abandon the operation.
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

  /** Withdraw tokens yan set. Teardown is explicit and complete. */
  public clearWorkspaceTokens(workspace: string, names: readonly string[]): void {
    requireWorkspaceId(workspace, 'workspace report-metadata');
    if (names.length === 0) return;
    const args = ['workspace', 'report-metadata', workspace, '--source', 'yan'];
    for (const name of names) args.push('--clear-token', name);
    this.call(args, 'workspace report-metadata');
  }

  /** Tell Herdr which shift a pane is (display.md §2). Display only. */
  public setPaneTitle(pane: string, title: string, displayAgent?: string): void {
    requirePaneId(pane, 'pane report-metadata');
    const args = ['pane', 'report-metadata', pane, '--source', 'yan', '--title', title];
    if (displayAgent !== undefined && displayAgent !== '') {
      args.push('--display-agent', displayAgent);
    }
    this.call(args, 'pane report-metadata');
  }

  /** Withdraw the title before the pane is closed. */
  public clearPaneTitle(pane: string): void {
    requirePaneId(pane, 'pane report-metadata');
    this.call(['pane', 'report-metadata', pane, '--source', 'yan', '--clear-title'], 'pane report-metadata');
  }

  /**
   * Read what is on an agent's terminal.
   *
   * `recent-unwrapped` for transcripts. Reading does NOT mark the tab seen,
   * which is the whole reason yan reads instead of focusing (rule 3).
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
   * alive | dead | unknown.
   *
   * THE ONE METHOD THAT NEEDS MORE THAN A SINGLE CALL, and this is where the
   * MVP's optimism about Herdr needed correcting: `agent get` answers
   * `agent_not_found` BOTH when the agent died and when it never existed
   * (evidence.md §5). The distinction lives one level down:
   *
   *   agent get <pane>
   *     ok                 → alive
   *     agent_not_found    → pane get <recorded pane id>
   *                            pane exists, no agent → dead
   *                            pane_not_found        → dead   (the pane was closed)
   *                            transport failure     → unknown
   *   transport failure    → unknown
   *
   * A Herdr server that is down produces `unknown`; a closed pane produces
   * `dead`.
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
   * Which workspace a pane belongs to, or `undefined` when Herdr cannot say.
   *
   * The id looks like `w1:p1` and the workspace looks like its prefix, which is
   * exactly the reason this is a call and not a substring: ids are opaque
   * (terminal.md §3), and a pane that `user` has moved carries a prefix that
   * was true when it was created. Herdr is asked.
   *
   * `undefined` rather than a throw, because the caller — `yan continue`,
   * working out which workspace to label — is not doing anything that may fail
   * for a display detail. A yan running outside Herdr altogether lands here too
   * and gets the same answer.
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
   * Reconcile a moved pane.
   *
   * `pane move` changes the pane id: a pane moved into another workspace gets a
   * new workspace-qualified one. yan never moves panes itself, but `user` can,
   * so when the recorded id is gone and an agent with the recorded NAME is
   * alive somewhere else, that is what happened.
   *
   * This REPORTS the new id. It does not write bookkeeping — rewriting
   * run/meta.json is the subcommand's job (architecture.md §4.3 rule 3).
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

  /** Close exactly the recorded pane. Nothing here can close a workspace or a tab; see rule 2. */
  public close(pane: string): void {
    requirePaneId(pane, 'close');
    this.call(['pane', 'close', pane], 'pane close');
  }

  /**
   * The agents Herdr knows about, with their pane ids, states and session ids.
   *
   * `container` filters to one workspace when given; a shift's pane id starts
   * with its workspace id, which is the only place that prefix is ever used as
   * more than an opaque string.
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
   * Split a pane to start an agent into.
   *
   * `--direction` is required by `pane split`; omitting it is an rc 2 CLI
   * syntax error, which this module reports as a bug in yan rather than as a
   * runtime condition.
   */
  private split(options: StartAgentOptions): string {
    const args = [
      'pane',
      'split',
      '--direction',
      options.direction ?? 'down',
      '--no-focus',
      '--cwd',
      nativePath(options.cwd),
    ];

    if (options.fromPane !== undefined && options.fromPane !== '') {
      args.push('--pane', requirePaneId(options.fromPane, 'pane split'));
    } else {
      requireWorkspaceId(options.container, 'pane split');
      args.push('--pane', this.firstPaneOf(options.container));
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('--env', `${key}=${value}`);
    }

    const split = asRecord(this.call(args, 'pane split'));
    const pane =
      str(asRecord(split.pane).pane_id) || str(split.pane_id) || str(asRecord(split.result).pane_id);
    if (pane === '') throw TerminalError.usage('herdr did not report a pane id for the split');
    return pane;
  }

  /**
   * Which pane to split from is DERIVED, never guessed from the workspace id:
   * `w1` does not imply `w1:p1` (ids are opaque, and a closed pane's id is
   * never reused). `workspace get` answers with WorkspaceInfo and carries no
   * root pane, so the panes are listed and filtered by workspace instead.
   */
  private firstPaneOf(container: string): string {
    const body = asRecord(this.call(['pane', 'list'], 'pane list'));
    const panes = Array.isArray(body.panes) ? body.panes : [];
    const first = panes
      .map((p) => asRecord(p))
      .filter((p) => str(p.workspace_id) === container)
      .map((p) => str(p.pane_id))
      .find((id) => id !== '');
    if (first === undefined) {
      throw TerminalError.usage(`${container} has no pane to split`);
    }
    return first;
  }
}
