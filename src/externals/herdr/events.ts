import { connect, type Socket } from 'node:net';
import { EventsError } from './errors.js';
import { isPaneId } from './ids.js';
import { defaultEndpoint } from './socket.js';
import { AGENT_STATUS } from './schema.js';
import { type AgentStatus, type AgentStatusEvent, type ClosedEvent } from './types.js';

/**
 * Herdr's event stream, spoken over the socket because `events.subscribe` has
 * no CLI verb. Newline-delimited JSON in both directions:
 *
 *   -> {"id":"yan:sub:1","method":"events.subscribe","params":{"subscriptions":[
 *        {"type":"pane.agent_status_changed","pane_id":"w1:p2"}]}}
 *   <- {"id":"yan:sub:1","result":{"type":"subscription_started"}}
 *   <- {"event":"pane.agent_status_changed","data":{"agent":"claude",
 *        "agent_status":"working","pane_id":"w1:p2","workspace_id":"w1"}}
 *
 * Subscribing is the only method this client sends: it cannot focus, close or
 * stop anything. There is no retry loop — a dropped connection reaches
 * `onClosed`, and coming back is `reconnect()`, at the caller's pace.
 */

const SUBSCRIBABLE = 'pane.agent_status_changed';

export interface TerminalEventsOptions {
  /** Defaults to this machine's Herdr socket. */
  readonly endpoint?: string;
  /** How long to wait for the connection itself. Defaults to 5000. */
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
   * Called when the connection ends, for any reason. Nothing reconnects on its
   * own afterwards.
   */
  public onClosed(handler: (event: ClosedEvent) => void): void {
    this.closedHandlers.push(handler);
  }

  /**
   * Open the connection, or return at once when it is already open.
   *
   * @throws EventsError `unreachable` when nothing answers within
   *   `connectTimeoutMs`.
   */
  public async open(): Promise<void> {
    if (this.socket !== undefined) return;
    const socket = await this.dial();
    this.socket = socket;
    this.buffer = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.receive(chunk);
    });
    socket.on('error', (err: Error) => {
      this.dropped(err.message);
    });
    socket.on('close', () => {
      this.dropped('the connection closed');
    });
  }

  /**
   * Subscribe to the agent status of panes that are not subscribed already, so
   * this is safe to call repeatedly with an overlapping set.
   *
   * @throws EventsError `usage` for anything that is not a pane id, `closed`
   *   when the connection is not open.
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
   * A fresh connection, then every pane subscribed again.
   *
   * @param panes replaces the remembered set when given.
   */
  public async reconnect(panes?: readonly string[]): Promise<void> {
    const restore = panes ?? [...this.panes];
    this.close();
    await this.open();
    await this.subscribe(restore);
  }

  /**
   * Let go of the connection and forget the subscribed panes, rejecting
   * anything still awaited. Idempotent, and never calls the `onClosed`
   * handlers.
   */
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
        // Not JSON: a preview build may print prose on the same stream.
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
    // An unrecognised status is `unknown`, never the string Herdr sent.
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
