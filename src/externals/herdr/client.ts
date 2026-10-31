import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { YanError } from '../../util/error.js';

/**
 * herdr, the terminal multiplexer an agent may run in: its socket API, as
 * much of it as `yan serve` needs to show a pane and type into it. One JSON
 * request a line, one JSON answer a line, over the socket herdr names in
 * each pane's `HERDR_SOCKET_PATH`; a connection is opened for each request,
 * which over a local socket costs next to nothing.
 *
 * What a pane shows comes as herdr's own live stream of it, `herdr terminal
 * session control`, rather than reads of its screen over and over: the
 * frames are the bytes a terminal draws, as they come. A controller sizes
 * the pane, so the page draws it filling its column, and scrolls it as herdr
 * scrolls a pane in its own window; while one holds the pane, herdr's own
 * window shows it at the controller's size. It came in herdr 0.7.2
 * (`CONTROL_SINCE`); keys go through the socket, which encodes them as the
 * program in the pane asked.
 */

/** The first herdr with `terminal session control`. */
export const CONTROL_SINCE = '0.7.2';

/** Whether `version` is `least` or later, numbers compared part by part; a version not read is not. */
export function atLeast(version: string, least: string): boolean {
  const parts = (v: string): number[] => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim()) ?? []).slice(1).map(Number);
  const [a, b] = [parts(version), parts(least)];
  if (a.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  return true;
}

/** What herdr says of a pane's agent: at work, waiting on `user` (a question or a permission), finished and not yet looked at, or idle. */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface Pane {
  readonly pane_id: string;
  /** The agent herdr found running in it, as `claude`; none once it has exited. */
  readonly agent?: string;
  readonly agent_status: AgentStatus;
  /** How far back the pane is scrolled and could be, in rows; a full-screen program's screen has nothing to scroll back to. */
  readonly scroll?: { readonly offset_from_bottom: number; readonly max_offset_from_bottom: number; readonly viewport_rows: number };
}

/**
 * The pane yan was started in, from the variables herdr sets in each of its
 * panes, with the herdr that set them; none outside herdr.
 */
export function herdrPane(env: NodeJS.ProcessEnv): { readonly pane: string; readonly socket: string; readonly bin: string } | undefined {
  const pane = env.HERDR_PANE_ID?.trim();
  const socket = env.HERDR_SOCKET_PATH?.trim();
  return env.HERDR_ENV === '1' && pane && socket ? { pane, socket, bin: env.HERDR_BIN_PATH?.trim() || 'herdr' } : undefined;
}

/** One request; rejects with herdr's own error code (`not_found` for a pane gone), or `herdr_unreachable` when nothing answers. */
export function call<T>(socket: string, method: string, params: Record<string, unknown>, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket);
    let got = '';
    let settled = false;
    const end = (then: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      then();
    };
    const timer = setTimeout(() => end(() => reject(new YanError('herdr_unreachable', `herdr did not answer ${method} within ${timeoutMs} ms`))), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify({ id: 'yan', method, params })}\n`));
    conn.on('data', (chunk: string) => {
      got += chunk;
      const nl = got.indexOf('\n');
      if (nl < 0) return;
      const line = got.slice(0, nl);
      end(() => {
        let answer: { result?: T; error?: { code?: string; message?: string } };
        try {
          answer = JSON.parse(line) as typeof answer;
        } catch {
          return reject(new YanError('herdr_unreachable', `herdr answered ${method} with something not JSON`));
        }
        if (answer.error !== undefined) return reject(new YanError(answer.error.code ?? 'herdr_error', answer.error.message ?? `herdr refused ${method}`));
        resolve(answer.result as T);
      });
    });
    conn.on('error', (err) => end(() => reject(new YanError('herdr_unreachable', `herdr is not answering at ${socket}: ${err.message}`))));
    conn.on('close', () => end(() => reject(new YanError('herdr_unreachable', `herdr closed the socket before answering ${method}`))));
  });
}

/** The version of the herdr answering on `socket`. */
export async function versionOf(socket: string): Promise<string> {
  return (await call<{ version?: string }>(socket, 'ping', {})).version ?? '';
}

export async function paneOf(socket: string, pane: string): Promise<Pane> {
  return (await call<{ pane: Pane }>(socket, 'pane.get', { pane_id: pane })).pane;
}

/** One frame of a pane's stream: ANSI bytes, base64, for a terminal `width` by `height`; a `full` one draws it all. */
export interface Frame {
  readonly type: 'terminal.frame';
  readonly width: number;
  readonly height: number;
  readonly full: boolean;
  readonly bytes: string;
}

/**
 * herdr's live stream of `pane`, sized `cols` by `rows`, taking it over from
 * any other controller: each line out a frame's JSON as herdr wrote it, then
 * `terminal.closed`; each line in a command (`controlCommand`). Its stdin
 * ending lets the pane go back to its own size. The herdr at `bin` finds its
 * server from `socket`.
 */
export function control(bin: string, socket: string, pane: string, cols: number, rows: number): ChildProcess {
  return spawn(bin, ['terminal', 'session', 'control', pane, '--takeover', '--cols', String(cols), '--rows', String(rows)], {
    env: { ...process.env, HERDR_SOCKET_PATH: socket },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** A controller's command: the pane sized anew, or the wheel turned `lines` rows over a 0-based cell, which herdr routes as in its own window. */
export function controlCommand(c: { readonly resize: { readonly cols: number; readonly rows: number } } | { readonly scroll: number; readonly col: number; readonly row: number }): string {
  if ('resize' in c) return JSON.stringify({ type: 'terminal.resize', cols: c.resize.cols, rows: c.resize.rows });
  return JSON.stringify({ type: 'terminal.scroll', direction: c.scroll < 0 ? 'up' : 'down', lines: Math.min(Math.abs(c.scroll), 50), column: c.col, row: c.row });
}

/** Scroll herdr's view of the pane back to `offset` rows from the bottom; 0 is the bottom. */
export async function scrollPane(socket: string, pane: string, offset: number): Promise<void> {
  await call(socket, 'pane.scroll', { pane_id: pane, offset_from_bottom: Math.max(0, Math.round(offset)) });
}

/** Bytes as they are, as a terminal sends what is typed. */
export async function sendText(socket: string, pane: string, text: string): Promise<void> {
  await call(socket, 'pane.send_text', { pane_id: pane, text });
}

/** Keys by herdr's names, `enter`, `esc`, `shift+tab`, `ctrl+c`, encoded as the program in the pane asked for. */
export async function sendKeys(socket: string, pane: string, keys: readonly string[]): Promise<void> {
  await call(socket, 'pane.send_keys', { pane_id: pane, keys });
}

/** Text as one paste, when the program takes pastes, then the keys: a message and its Enter in one go. */
export async function sendInput(socket: string, pane: string, text: string, keys: readonly string[]): Promise<void> {
  await call(socket, 'pane.send_input', { pane_id: pane, text, keys });
}
