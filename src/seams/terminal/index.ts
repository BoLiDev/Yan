import { usageError } from '../../util/error.js';
import { nativePath } from '../../util/paths.js';
import { herdrCall, mapError, runHerdr, TERM_NOT_FOUND } from './client.js';
import type { AgentStatus } from './types.js';

/**
 * The terminal seam, on Herdr (terminal.md).
 *
 * One terminal container per task. The concepts line up like this:
 *
 *     the task container   ->  a workspace   (w1)
 *     one agent            ->  a pane        (w1:p1)
 *     a terminal           ->  a pane
 *
 * Seven functions, and every Herdr command in yan lives behind one of them.
 *
 * Four rules this module exists to hold. They are the tmux implementation's
 * four, unchanged — only the multiplexer moved:
 *
 *   1. A LABEL IS NOT A SOURCE OF TRUTH; RECORD THE ID. Herdr does enforce that
 *      an agent NAME is unique among LIVE agents, which tmux never promised —
 *      but a name is cleared when the agent exits, so it cannot identify a
 *      shift that has died, and identifying dead shifts is precisely what
 *      supervision does. So ids are still what is recorded and what is passed
 *      (terminal.md §3).
 *
 *   2. CLOSE EXACTLY ONE THING. `termAgentClose` closes the recorded pane and
 *      nothing else. There is no code path here that can close a workspace or a
 *      tab — `workspace close` and `tab close` are simply not spelled anywhere
 *      in this file, and a test greps for them. Container lifetime belongs to
 *      `user`: yan never closes a workspace, a tab, or a pane it did not
 *      create.
 *
 *   3. DO NOT STEAL FOCUS. Every call that could move the user passes
 *      `--no-focus`. **And `yan` never calls `agent focus` on a shift's pane**,
 *      for a second reason that is easy to miss: focusing marks the tab SEEN,
 *      which turns the `done` yan was about to be woken by into an `idle` it
 *      will ignore (supervision.md §3). `agent read` does not mark it seen.
 *      That is a real footgun, so it is written here and not only in the design.
 *
 *   4. REPORT FACTS, DECIDE NOTHING. `termAgentAlive` answers with one of three
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

export type { AgentStatus } from './types.js';
export { HERDR_PROTOCOL, HERDR_SCHEMA_VERSION } from './types.js';
export { AGENT_STATUS as AGENT_STATUS_VALUES } from './types.js';
export { TERM_BUG, TERM_NOT_FOUND, TERM_REFUSED, TERM_UNREACHABLE } from './client.js';

export type Alive = 'alive' | 'dead' | 'unknown';

export interface Container {
  readonly workspace: string;
  readonly tab: string;
  readonly pane: string;
}

export interface StartedAgent {
  readonly name: string;
  readonly pane: string;
  readonly status: AgentStatus;
  /** The agent CLI's own session id, when its integration reported one. */
  readonly agent_session?: string;
}

export interface ListedAgent {
  /**
   * The name `agent start` was given. Empty for an agent `user` started by
   * hand: Herdr's `name` is null unless yan (or another automation) named it,
   * which is one more reason the pane id is what gets recorded.
   */
  readonly name: string;
  readonly pane: string;
  readonly status: AgentStatus;
  /** The agent kind Herdr detected: claude, codex, … */
  readonly kind: string;
  readonly title?: string;
  readonly agent_session?: string;
}

export type ReadSource = 'visible' | 'recent' | 'recent-unwrapped' | 'detection';

// --- identifiers ------------------------------------------------------------

/**
 * `w1`, or `w1:p1`. OPAQUE and stable; never reused after close.
 *
 * Opaque is meant literally, and it is easy to get wrong: terminal.md §3 gives
 * `w1` and `w1:p1` as the SHAPE, and after enough workspaces this Herdr hands
 * out `wB` and `wB:p2`. So the guard checks the shape a caller could confuse
 * with a label — a `w…` prefix, a `:p…` suffix — and nothing about what is
 * inside them.
 */
const WORKSPACE_ID = /^w[0-9A-Za-z]+$/;
const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
const TAB_ID = /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/;
/** Herdr's own rule for an agent name. */
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function requirePaneId(value: string, what: string): string {
  if (!PANE_ID.test(value)) {
    throw usageError(
      'term_usage',
      `${what} needs a pane id like w1:p1, never a label: got '${value}'`,
    );
  }
  return value;
}

function requireWorkspaceId(value: string, what: string): string {
  if (!WORKSPACE_ID.test(value)) {
    throw usageError(
      'term_usage',
      `${what} needs a workspace id like w1, never a name: got '${value}'`,
    );
  }
  return value;
}

function requireAgentName(value: string): string {
  if (!AGENT_NAME.test(value)) {
    throw usageError(
      'term_usage',
      `an agent name is [a-z][a-z0-9_-]{0,31}: got '${value}'`,
    );
  }
  return value;
}

// --- reading Herdr's JSON ---------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function statusOf(value: unknown): AgentStatus {
  const s = str(value);
  return s === 'idle' || s === 'working' || s === 'blocked' || s === 'done' ? s : 'unknown';
}

/**
 * `pane list` returns `agent_session: {kind:"id", source:"herdr:claude", value}`
 * and the value is the agent CLI's own session id. It arrives via the
 * integration's SessionStart hook, so its ABSENCE IS NORMAL, not an error
 * (terminal.md §7).
 */
function agentSessionOf(value: unknown): string | undefined {
  const session = asRecord(value);
  const v = str(session.value);
  return v === '' ? undefined : v;
}

/** The pane ids of one workspace, in the order Herdr lists them. */
function containerPanes(container: string): string[] {
  const result = herdrCall(['pane', 'list'], 'pane list');
  const body = asRecord(result);
  const panes = Array.isArray(body.panes) ? body.panes : [];
  return panes
    .map((p) => asRecord(p))
    .filter((p) => str(p.workspace_id) === container)
    .map((p) => str(p.pane_id))
    .filter((id) => id !== '');
}

// --- the seven functions ----------------------------------------------------

/**
 * 1/7 — create the task container.
 *
 * Only when `user` asks for a new workspace; normally yan joins the one it is
 * already in (cli-ux.md). `--no-focus` because creating a container must not
 * move whoever asked for it.
 */
export function termContainerCreate(label: string, cwd?: string): Container {
  if (label === '') throw usageError('term_usage', 'a container label is required');
  const args = ['workspace', 'create', '--label', label, '--no-focus'];
  if (cwd !== undefined && cwd !== '') args.push('--cwd', nativePath(cwd));

  const result = asRecord(herdrCall(args, 'workspace create'));
  const workspace = asRecord(result.workspace);
  return {
    workspace: str(workspace.workspace_id) || str(result.workspace_id),
    tab: str(asRecord(result.tab).tab_id) || str(result.tab_id),
    pane: str(asRecord(result.root_pane).pane_id) || str(result.root_pane_id),
  };
}

/**
 * 2/7 — start an agent.
 *
 * TWO STEPS, and they are not interchangeable: `agent start` requires an
 * existing pane already at an interactive prompt and never creates layout
 * (terminal.md §2). So the pane is split first, with the environment and the
 * working directory, and the agent is started into it.
 *
 * It returns only once Herdr has detected the expected agent in that pane and
 * considers it ready for input, which is what deletes the MVP's send-keys-and-
 * hope start confirmation.
 */
export function termAgentStart(options: {
  readonly container: string;
  readonly name: string;
  readonly kind: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly argv?: readonly string[];
  readonly timeoutMs?: number;
  /** Split this pane instead of the container's root pane. */
  readonly fromPane?: string;
  /** `down` by default: a sibling pane in the current tab, never a new tab. */
  readonly direction?: 'right' | 'down';
}): StartedAgent {
  requireAgentName(options.name);
  if (options.kind === '') throw usageError('term_usage', 'an agent kind is required');
  if (options.cwd === '') throw usageError('term_usage', 'a working directory is required');

  // `--direction` is required by `pane split`; omitting it is an rc 2 CLI
  // syntax error, which this seam reports as a bug in yan rather than as a
  // runtime condition.
  const splitArgs = [
    'pane',
    'split',
    '--direction',
    options.direction ?? 'down',
    '--no-focus',
    '--cwd',
    nativePath(options.cwd),
  ];
  if (options.fromPane !== undefined && options.fromPane !== '') {
    splitArgs.push('--pane', requirePaneId(options.fromPane, 'pane split'));
  } else {
    requireWorkspaceId(options.container, 'pane split');
    // Which pane to split from is DERIVED, never guessed from the workspace id:
    // `w1` does not imply `w1:p1` (ids are opaque, and a closed pane's id is
    // never reused). `workspace get` answers with WorkspaceInfo and carries no
    // root pane, so the panes are listed and filtered by workspace instead.
    const root = containerPanes(options.container)[0];
    if (root === undefined) {
      throw usageError('term_usage', `${options.container} has no pane to split`);
    }
    splitArgs.push('--pane', root);
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    splitArgs.push('--env', `${key}=${value}`);
  }

  const split = asRecord(herdrCall(splitArgs, 'pane split'));
  const pane =
    str(asRecord(split.pane).pane_id) || str(split.pane_id) || str(asRecord(split.result).pane_id);
  if (pane === '') throw usageError('term_usage', 'herdr did not report a pane id for the split');

  const startArgs = ['agent', 'start', options.name, '--kind', options.kind, '--pane', pane];
  if (options.timeoutMs !== undefined) startArgs.push('--timeout', String(options.timeoutMs));
  // Everything after `--` reaches the agent as argv. No shell, so no quoting
  // layer: `--append-system-prompt "a b"` survives intact (evidence.md §2).
  if (options.argv !== undefined && options.argv.length > 0) startArgs.push('--', ...options.argv);

  const started = asRecord(herdrCall(startArgs, 'agent start'));
  const agent = asRecord(started.agent);
  const session = agentSessionOf(agent.agent_session);
  return {
    name: str(agent.name) || options.name,
    pane: str(agent.pane_id) || pane,
    status: statusOf(agent.agent_status),
    ...(session === undefined ? {} : { agent_session: session }),
  };
}

/**
 * 3/7 — send one prompt.
 *
 * Atomic: text and Enter in one submission, honouring the pane's live
 * bracketed-paste mode. The MVP's `--no-enter` / `--enter` split existed
 * because tmux `send-keys` could not do that; there is nothing left for it
 * to do here.
 */
export function termSend(pane: string, text: string, waitMs?: number): void {
  requirePaneId(pane, 'termSend');
  if (text === '') throw usageError('term_usage', 'there is nothing to send');
  const args = ['agent', 'prompt', pane, text];
  if (waitMs !== undefined) args.push('--wait', '--timeout', String(waitMs));
  herdrCall(args, 'agent prompt');
}

/**
 * 4/7 — read what is on an agent's terminal.
 *
 * `recent-unwrapped` for transcripts. Reading does NOT mark the tab seen, which
 * is the whole reason yan reads instead of focusing (rule 3).
 */
export function termRead(pane: string, lines = 80, source: ReadSource = 'recent-unwrapped'): string {
  requirePaneId(pane, 'termRead');
  if (!Number.isInteger(lines) || lines <= 0) {
    throw usageError('term_usage', `a whole number of lines is required, got '${lines}'`);
  }
  const result = herdrCall(
    ['agent', 'read', pane, '--source', source, '--lines', String(lines)],
    'agent read',
  );
  const body = asRecord(result);
  if (typeof body.text === 'string') return body.text;
  if (Array.isArray(body.lines)) return body.lines.map((l) => str(l)).join('\n');
  return '';
}

/**
 * 5/7 — alive | dead | unknown.
 *
 * THE ONE FUNCTION THAT NEEDS MORE THAN A SINGLE CALL, and this is where the
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
 * `unknown` is reserved for "yan could not find out", never for "yan found out
 * something confusing". A Herdr server that is down produces `unknown`; a
 * closed pane produces `dead`.
 */
export function termAgentAlive(pane: string): Alive {
  requirePaneId(pane, 'termAgentAlive');

  const agent = runHerdr(['agent', 'get', pane]);
  if (agent.code === 0) return 'alive';
  const agentError = mapError(agent, 'agent get');
  if (agentError.code !== TERM_NOT_FOUND) return 'unknown';

  const paneResult = runHerdr(['pane', 'get', pane]);
  if (paneResult.code === 0) return 'dead';
  const paneError = mapError(paneResult, 'pane get');
  return paneError.code === TERM_NOT_FOUND ? 'dead' : 'unknown';
}

/**
 * Reconcile a moved pane.
 *
 * `pane move` changes the pane id: a pane moved into another workspace gets a
 * new workspace-qualified one. yan never moves panes itself, but `user` can, so
 * when the recorded id is gone and an agent with the recorded NAME is alive
 * somewhere else, that is what happened.
 *
 * The seam REPORTS the new id. It does not write bookkeeping — rewriting
 * run/meta.json is the subcommand's job (architecture.md §4.3 rule 3).
 */
export function termReconcile(name: string, recordedPane: string): string | undefined {
  requireAgentName(name);
  const byName = runHerdr(['agent', 'get', name]);
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
 * 6/7 — close exactly the recorded pane.
 *
 * Nothing here can close a workspace or a tab; see rule 2.
 */
export function termAgentClose(pane: string): void {
  requirePaneId(pane, 'termAgentClose');
  herdrCall(['pane', 'close', pane], 'pane close');
}

/**
 * 7/7 — the agents Herdr knows about, with their pane ids, states and session
 * ids.
 *
 * `container` filters to one workspace when given; a shift's pane id starts
 * with its workspace id, which is the only place that prefix is ever used as
 * more than an opaque string.
 */
export function termList(container?: string): ListedAgent[] {
  if (container !== undefined && container !== '') requireWorkspaceId(container, 'termList');

  const result = herdrCall(['agent', 'list'], 'agent list');
  const body = asRecord(result);
  const raw = Array.isArray(body.agents) ? body.agents : Array.isArray(result) ? result : [];

  const agents: ListedAgent[] = [];
  for (const entry of raw) {
    const agent = asRecord(entry);
    const pane = str(agent.pane_id);
    if (container !== undefined && container !== '' && !pane.startsWith(`${container}:`)) continue;
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

// --- version stamp ----------------------------------------------------------

export interface HerdrVersion {
  readonly version: string;
  readonly protocol: number;
  readonly schemaVersion: number;
}

/**
 * What the installed binary says about itself. `yan doctor` compares it with
 * the stamps in the generated types; a mismatch is a version check, and is
 * never worded as "supervision is authoritative" (terminal.md §6).
 */
export function termVersion(): HerdrVersion | undefined {
  const version = runHerdr(['--version']);
  if (version.code !== 0) return undefined;
  const schema = runHerdr(['api', 'schema', '--json']);
  if (schema.code !== 0) return undefined;
  try {
    const parsed = asRecord(JSON.parse(schema.stdout));
    return {
      version: version.stdout.trim(),
      protocol: typeof parsed.protocol === 'number' ? parsed.protocol : -1,
      schemaVersion: typeof parsed.schema_version === 'number' ? parsed.schema_version : -1,
    };
  } catch {
    return undefined;
  }
}

/** `herdr integration status`, one line per kind, parsed into name → state. */
export function termIntegrationStatus(): Record<string, string> {
  const result = runHerdr(['integration', 'status']);
  if (result.code !== 0) return {};
  const status: Record<string, string> = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*([a-z0-9_-]+):\s+(\S+)/.exec(line);
    if (match !== null) status[match[1] as string] = match[2] as string;
  }
  return status;
}
