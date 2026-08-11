import { connect, type Socket } from 'node:net';
import { EventsError } from './errors.js';
import { isPaneId } from './ids.js';
import { defaultEndpoint } from './socket.js';
import { AGENT_STATUS } from './schema.js';
import { type AgentStatus, type AgentStatusEvent, type ClosedEvent } from './types.js';

/**
 * Herdr's event stream, over the socket (supervision.md §2, evidence §11.1).
 *
 * `herdr api` has exactly two subcommands, `snapshot` and `schema`.
 * `events.subscribe` exists in the request schema and has NO CLI VERB AT ALL,
 * so the terminal seam's CLI transport does not reach it and this module speaks
 * the wire protocol itself. That is the whole reason a second module exists for
 * one outside authority.
 *
 * Newline-delimited JSON in both directions:
 *
 *   -> {"id":"yan:sub:1","method":"events.subscribe","params":{"subscriptions":[
 *        {"type":"pane.agent_status_changed","pane_id":"w1:p2"}]}}
 *   <- {"id":"yan:sub:1","result":{"type":"subscription_started"}}
 *   <- {"event":"pane.agent_status_changed","data":{"agent":"claude",
 *        "agent_status":"working","pane_id":"w1:p2","workspace_id":"w1"}}
 *
 * Three rules this module holds, and the first two are the terminal seam's:
 *
 *   1. RECORD THE ID, NEVER THE LABEL. Subscriptions are per pane id; a pane
 *      that has moved is reconciled by whoever owns the bookkeeping, not here.
 *
 *   2. IT CANNOT MOVE THE USER OR CLOSE ANYTHING. This client sends exactly one
 *      method. There is no `focus`, no `close`, no `stop` — a subscriber that
 *      could focus a pane would mark it seen and turn the `done` yan is waiting
 *      for into an `idle` it ignores (supervision.md §3).
 *
 *   3. IT NEVER DECIDES. A status arrives as a fact with a pane id on it.
 *      Whether `blocked` is worth waking anybody is `yan wait`'s judgement, and
 *      `done` in particular is a reason to look and never a verdict.
 *
 * RECONNECTION IS THE CALLER'S PACING. `reconnect()` is offered; no hidden
 * retry loop is. The Phase 5 spike held one subscription for 420 s and never
 * saw a server restart (evidence §11.4), so "the subscription ended" is handled
 * as a state that can arrive at any time — but how often to try again, and what
 * to re-read before doing so, is supervision's decision and not this module's.
 */

const SUBSCRIBABLE = 'pane.agent_status_changed';

/** Herdr's pane id shape. Opaque: checked for shape, never parsed. */

export interface TerminalEventsOptions {
  /** Defaults to this machine's Herdr socket, with the Windows pipe-name rule applied. */
  readonly endpoint?: string;
  /** How long to wait for the connection itself. */
  readonly connectTimeoutMs?: number;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export class TerminalEvents {
  public readonly endpoint: string;

  private readonly connectTimeoutMs: number;
  private socket: Socket | undefined;
  private buffer = '';
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  /** The panes this client is subscribed to, so a reconnect can restore them. */
  private readonly panes = new Set<string>();
  private readonly statusHandlers: ((event: AgentStatusEvent) => void)[] = [];
  private readonly closedHandlers: ((event: ClosedEvent) => void)[] = [];

  public constructor(options: TerminalEventsOptions = {}) {
    this.endpoint = options.endpoint ?? defaultEndpoint();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  }

  public get connected(): boolean {
    return this.socket !== undefined;
  }

  /** The panes currently subscribed, in the order they were added. */
  public get subscribed(): readonly string[] {
    return [...this.panes];
  }

  public onStatus(handler: (event: AgentStatusEvent) => void): void {
    this.statusHandlers.push(handler);
  }

  /**
   * The subscription ended. Not an error and not a verdict about Herdr: the
   * caller decides whether to come back, and how soon.
   */
  public onClosed(handler: (event: ClosedEvent) => void): void {
    this.closedHandlers.push(handler);
  }

  /** Open the connection. Throws `events_unreachable` when there is nothing there. */
  public async open(): Promise<void> {
    if (this.socket !== undefined) return;
    const socket = await this.dial();
    this.socket = socket;
    this.buffer = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.receive(chunk);
    });
    // Both arrive for the same event on different platforms; `end` is a clean
    // server-side close and `error` is a reset. Neither is a reason to throw at
    // whoever happens to be awaiting something else.
    socket.on('error', (err: Error) => {
      this.dropped(err.message);
    });
    socket.on('close', () => {
      this.dropped('the connection closed');
    });
  }

  /**
   * Subscribe to one pane's agent status, or several.
   *
   * Panes already subscribed are skipped, so this is safe to call every turn of
   * a watcher's loop as shifts come and go.
   */
  public async subscribe(panes: readonly string[]): Promise<void> {
    const wanted = panes.filter((pane) => {
      if (!isPaneId(pane)) {
        throw EventsError.usage(`a subscription needs a pane id like w1:p1, never a label: got '${pane}'`);
      }
      return !this.panes.has(pane);
    });
    if (wanted.length === 0) return;

    await this.request('events.subscribe', {
      subscriptions: wanted.map((pane) => ({ type: SUBSCRIBABLE, pane_id: pane })),
    });
    for (const pane of wanted) this.panes.add(pane);
  }

  /**
   * Come back after the subscription ended: a fresh connection, then every pane
   * subscribed again.
   *
   * `panes` replaces the remembered set when given — which is how a watcher
   * re-subscribes from `run/meta.json` rather than from what it happened to
   * hold in memory before the connection dropped.
   */
  public async reconnect(panes?: readonly string[]): Promise<void> {
    // Read the set BEFORE closing: `close()` forgets it, which is what makes a
    // deliberate close different from a connection that dropped.
    const restore = panes ?? [...this.panes];
    this.close();
    await this.open();
    await this.subscribe(restore);
  }

  /** Let go of the connection. Idempotent; releases the event loop. */
  public close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.panes.clear();
    this.failPending('the client closed the connection');
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  private dial(): Promise<Socket> {
    return new Promise<Socket>((resolveDial, rejectDial) => {
      const socket = connect(this.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        rejectDial(
          new EventsError('unreachable', `herdr did not accept a connection at ${this.endpoint} within ${this.connectTimeoutMs}ms`),
        );
      }, this.connectTimeoutMs);
      timer.unref();

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolveDial(socket);
      });
      socket.once('error', (err: Error) => {
        clearTimeout(timer);
        socket.destroy();
        rejectDial(
          new EventsError('unreachable', `cannot reach herdr's event socket at ${this.endpoint}: ${err.message}`, {
            cause: err,
          }),
        );
      });
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (socket === undefined) {
      return Promise.reject(new EventsError('closed', `not connected to ${this.endpoint}`));
    }
    this.seq += 1;
    const id = `yan:${this.seq}`;
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      socket.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
        if (err === undefined || err === null) return;
        this.pending.delete(id);
        rejectRequest(new EventsError('closed', `could not send ${method}: ${err.message}`, { cause: err }));
      });
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === '') continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        // A preview build may print prose. Ignoring a line we cannot read is
        // strictly better than dying on the watcher's only event channel.
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const body = message as Record<string, unknown>;

    if (typeof body.event === 'string') {
      if (body.event !== SUBSCRIBABLE) return;
      const event = this.statusEvent(body.data);
      if (event === undefined) return;
      for (const handler of this.statusHandlers) handler(event);
      return;
    }

    const id = typeof body.id === 'string' ? body.id : undefined;
    if (id === undefined) return;
    const waiting = this.pending.get(id);
    if (waiting === undefined) return;
    this.pending.delete(id);

    const error = body.error;
    if (error !== undefined && error !== null) {
      // The Herdr code is mapped here and nowhere else: nothing above this
      // module ever sees `invalid_request`.
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'unknown';
      waiting.reject(new EventsError('refused', `herdr refused the subscription: ${code}`));
      return;
    }
    waiting.resolve(body.result);
  }

  private statusEvent(data: unknown): AgentStatusEvent | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const body = data as Record<string, unknown>;
    const pane = typeof body.pane_id === 'string' ? body.pane_id : '';
    if (pane === '') return undefined;
    const raw = typeof body.agent_status === 'string' ? body.agent_status : '';
    // An unrecognised status is `unknown`, never the string Herdr sent: the
    // union is the contract, and `unknown` already means "yan could not tell".
    const status: AgentStatus = (AGENT_STATUS as readonly string[]).includes(raw)
      ? (raw as AgentStatus)
      : 'unknown';
    return { pane, status, kind: typeof body.agent === 'string' ? body.agent : '' };
  }

  private dropped(reason: string): void {
    if (this.socket === undefined) return;
    const socket = this.socket;
    this.socket = undefined;
    socket.removeAllListeners();
    socket.destroy();
    this.failPending(reason);
    for (const handler of this.closedHandlers) handler({ reason });
  }

  private failPending(reason: string): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      waiting.reject(new EventsError('closed', `the event connection ended before ${id} was answered: ${reason}`));
    }
  }
}
