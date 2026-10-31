import { execFile, spawn, type ChildProcess } from 'node:child_process';
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

/**
 * How herdr has split the tab a pane is in: a pane, or two side by side
 * (`right`) or one over the other (`down`), the first taking `ratio` of the
 * room.
 */
export type Layout =
  | { readonly pane: string }
  | { readonly split: 'right' | 'down'; readonly ratio: number; readonly first: Layout; readonly second: Layout };

interface LayoutNode {
  readonly type: 'pane' | 'split';
  readonly pane_id?: string;
  readonly direction?: string;
  readonly ratio?: number;
  readonly first?: LayoutNode;
  readonly second?: LayoutNode;
}

function layoutFrom(node: LayoutNode): Layout {
  if (node.type !== 'split' || node.first === undefined || node.second === undefined) return { pane: node.pane_id ?? '' };
  const ratio = typeof node.ratio === 'number' && node.ratio > 0 && node.ratio < 1 ? node.ratio : 0.5;
  return { split: node.direction === 'down' ? 'down' : 'right', ratio, first: layoutFrom(node.first), second: layoutFrom(node.second) };
}

/** The panes of the tab `pane` is in, as herdr has them split (herdr 0.7.0 and later). */
export async function layoutOf(socket: string, pane: string): Promise<Layout> {
  return layoutFrom((await call<{ layout: { root: LayoutNode } }>(socket, 'layout.export', { pane_id: pane })).layout.root);
}

/** What `pane` shows, as text, and herdr's count of its changes, which moves with each. */
export async function readPane(socket: string, pane: string): Promise<{ text: string; revision: number }> {
  const { read } = await call<{ read: { text: string; revision: number } }>(socket, 'pane.read', { pane_id: pane, source: 'visible' });
  return { text: read.text, revision: read.revision };
}

/** The tab `pane` is in. */
export async function tabOf(socket: string, pane: string): Promise<string> {
  return (await call<{ layout: { tab_id: string } }>(socket, 'layout.export', { pane_id: pane })).layout.tab_id;
}

/** The tab closed, every pane in it and whatever runs in them with it. */
export async function closeTab(socket: string, tab: string): Promise<void> {
  await call(socket, 'tab.close', { tab_id: tab });
}

/** Every pane a layout holds, first to last. */
export function panesIn(layout: Layout): string[] {
  return 'pane' in layout ? [layout.pane] : [...panesIn(layout.first), ...panesIn(layout.second)];
}

/**
 * A new pane split off `pane`, beside it or below it, a shell in the
 * directory the pane is working in, as herdr's own split makes one; herdr's
 * focus stays where it was. Its id.
 */
export async function splitPane(socket: string, pane: string, direction: 'right' | 'down'): Promise<string> {
  return (await call<{ pane: { pane_id: string } }>(socket, 'pane.split', { target_pane_id: pane, direction, focus: false })).pane.pane_id;
}

/** The pane closed, and whatever runs in it with it. */
export async function closePane(socket: string, pane: string): Promise<void> {
  await call(socket, 'pane.close', { pane_id: pane });
}

/** The herdr server a herdr command talks to: whether one runs, its version, and the socket it answers on. */
export interface Server {
  readonly running: boolean;
  readonly version: string;
  readonly socket: string;
}

/**
 * The herdr server the herdr at `bin` finds, as `herdr status server --json`
 * says (herdr 0.5.3 and later): the session it would attach to, wherever
 * that session keeps its socket.
 */
export function serverOf(bin: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['status', 'server', '--json'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      let said: { running?: boolean; version?: string | null; socket?: string } | undefined;
      try {
        said = JSON.parse(stdout) as typeof said;
      } catch {
        said = undefined;
      }
      if (said?.socket === undefined) return reject(new YanError('herdr_unreachable', `${bin} status server said nothing yan can read${err ? `: ${err.message}` : ''}`));
      resolve({ running: said.running === true, version: said.version ?? '', socket: said.socket });
    });
  });
}

/**
 * A new tab in herdr's focused workspace, named `label`, its shell started
 * in `cwd` with `env` beside herdr's own, herdr's focus left where it is.
 * Its first pane.
 */
export async function createTab(socket: string, tab: { readonly cwd: string; readonly label: string; readonly env: Readonly<Record<string, string>> }): Promise<string> {
  return (await call<{ root_pane: { pane_id: string } }>(socket, 'tab.create', { cwd: tab.cwd, label: tab.label, env: tab.env, focus: false })).root_pane.pane_id;
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
