import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { mkTempDir } from './fixtures.js';

/**
 * A herdr to start yan against: its socket answering as herdr's does over a
 * small model of one workspace, and a `herdr` command beside it, whose
 * `terminal session control` streams a pane and keeps what it is told. A
 * test asks the model what reached herdr's panes and tabs, so it checks what
 * the program in a pane would see, never which calls yan made to get there.
 *
 *   const h = await startFakeHerdr({ version: '0.9.5' });
 *   h.socket, h.bin        the herdr a terminal yan keeps names
 *   h.terminal(v, task)    such a terminal, for ~/.yan/config.json's `terminals`
 *   h.received(pane)       what the program in a pane was sent, oldest first
 *   h.wheels(pane)         the mouse wheel as that program reads it from what it was sent
 *   h.scrolledBack(pane)   how many rows herdr's own view of the pane is scrolled back
 *   h.controllers()        every `terminal session control` started, with what it was told
 *   h.tabs()               every tab open, with its panes as herdr has them split
 *   await h.close()
 *
 * It starts with one tab, w1:t1, split right at 0.6: the agent's pane
 * (`AGENT_PANE`, claude waiting on the user, full-screen, so with no history
 * to scroll back) and a shell beside it (`SHELL_PANE`, with history). A tab
 * opened, or a pane split off, gets a shell that draws its prompt
 * `shellAfterMs` later; anything sent to it before then is marked `early`,
 * as a shell would echo it and draw it again.
 *
 * POSIX only: the command is a script with a shebang.
 */

export const AGENT_PANE = 'w1:p2';
export const SHELL_PANE = 'w1:p3';

/** What the program in a pane was sent: bytes as typed, keys by herdr's names, or a paste and the keys after it. */
export type Received = ({ readonly text: string } | { readonly keys: readonly string[] } | { readonly paste: string; readonly keys: readonly string[] }) & { readonly early?: true };

/** A `herdr terminal session control` of a pane: the size it asked for, the socket it was pointed at, and the commands it was sent. */
export interface Controller {
  readonly pane: string;
  readonly cols: number;
  readonly rows: number;
  readonly socket: string;
  readonly commands: readonly unknown[];
  /** Still holding the pane: its stdin, which is yan's hold of it, has not ended. */
  readonly holding: boolean;
}

/** How herdr has a tab split, as `layout.export` gives it. */
export type Node =
  | { readonly type: 'pane'; readonly pane_id: string }
  | { readonly type: 'split'; readonly direction: 'right' | 'down'; readonly ratio: number; readonly first: Node; readonly second: Node };

export interface Tab {
  readonly id: string;
  readonly label: string;
  /** The shell's directory and environment, as the tab was opened with them. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly focused: boolean;
  readonly root: Node;
  readonly panes: readonly string[];
}

export interface FakeHerdr {
  readonly socket: string;
  readonly bin: string;
  terminal(vault: string, task: string, pane?: string): { vault: string; task: string; pane: string; socket: string; bin: string; cli: string; since: string };
  received(pane: string): Received[];
  wheels(pane: string): { up: boolean; col: number; row: number }[];
  scrolledBack(pane: string): number | undefined;
  controllers(): Controller[];
  tabs(): Tab[];
  close(): Promise<void>;
}

interface PaneState {
  agent?: string;
  status: string;
  scroll: { offset: number; max: number };
  /** When its shell has drawn its prompt, and what it shows from then. */
  promptAt: number;
  screen: string;
  received: Received[];
}

interface TabState {
  id: string;
  label: string;
  cwd?: string;
  env?: Record<string, string>;
  root: Node;
}

const panesOf = (n: Node): string[] => (n.type === 'pane' ? [n.pane_id] : [...panesOf(n.first), ...panesOf(n.second)]);

/** `n` with the pane `id` replaced by what `by` makes of it, or taken out when `by` gives undefined. */
function replace(n: Node, id: string, by: (leaf: Node) => Node | undefined): Node | undefined {
  if (n.type === 'pane') return n.pane_id === id ? by(n) : n;
  const [first, second] = [replace(n.first, id, by), replace(n.second, id, by)];
  if (first === undefined) return second;
  if (second === undefined) return first;
  return { ...n, first, second };
}

class Refused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function startFakeHerdr(options: { version: string; shellAfterMs?: number }): Promise<FakeHerdr> {
  const dir = mkTempDir('yan-herdr-');
  const socket = join(dir, 'herdr.sock');
  const bin = join(dir, 'herdr');
  const log = join(dir, 'control.log');
  const shellAfter = options.shellAfterMs ?? 200;

  const panes = new Map<string, PaneState>([
    [AGENT_PANE, { agent: 'claude', status: 'blocked', scroll: { offset: 0, max: 0 }, promptAt: 0, screen: 'Do you want to proceed?', received: [] }],
    [SHELL_PANE, { status: 'unknown', scroll: { offset: 0, max: 200 }, promptAt: 0, screen: '~ ❯ ', received: [] }],
  ]);
  const tabs = new Map<string, TabState>([
    ['w1:t1', { id: 'w1:t1', label: 'agent', root: { type: 'split', direction: 'right', ratio: 0.6, first: { type: 'pane', pane_id: AGENT_PANE }, second: { type: 'pane', pane_id: SHELL_PANE } } }],
  ]);
  let focused = 'w1:t1';
  let [nextPane, nextTab] = [4, 2];

  const pane = (id: unknown): PaneState => {
    const p = typeof id === 'string' ? panes.get(id) : undefined;
    if (p === undefined) throw new Refused('not_found', `pane ${String(id)} not found`);
    return p;
  };
  const tabWith = (id: unknown): TabState => {
    pane(id);
    return [...tabs.values()].find((t) => panesOf(t.root).includes(id as string)) as TabState;
  };
  const shell = (): string => {
    const id = `w1:p${nextPane++}`;
    panes.set(id, { status: 'unknown', scroll: { offset: 0, max: 0 }, promptAt: Date.now() + shellAfter, screen: '~ ❯ ', received: [] });
    return id;
  };
  const take = (id: unknown, what: Received): { type: 'ok' } => {
    const p = pane(id);
    p.received.push(Date.now() < p.promptAt ? { ...what, early: true } : what);
    return { type: 'ok' };
  };

  const answer = (method: string, q: Record<string, unknown>): unknown => {
    switch (method) {
      case 'ping':
        return { type: 'pong', version: options.version };
      case 'pane.get': {
        const p = pane(q.pane_id);
        return { type: 'pane_info', pane: { pane_id: q.pane_id, ...(p.agent === undefined ? {} : { agent: p.agent }), agent_status: p.status, scroll: { offset_from_bottom: p.scroll.offset, max_offset_from_bottom: p.scroll.max, viewport_rows: 30 } } };
      }
      case 'pane.read': {
        const p = pane(q.pane_id);
        const drawn = Date.now() >= p.promptAt;
        return { type: 'pane_read', read: { pane_id: q.pane_id, text: drawn ? p.screen : '', revision: drawn ? 2 : 1, truncated: false } };
      }
      case 'layout.export': {
        const t = tabWith(q.pane_id);
        return { type: 'layout_export', layout: { workspace_id: 'w1', tab_id: t.id, zoomed: false, focused_pane_id: panesOf(t.root)[0], root: t.root } };
      }
      case 'pane.split': {
        const t = tabWith(q.target_pane_id);
        const made = shell();
        const direction = q.direction === 'down' ? 'down' : 'right';
        t.root = replace(t.root, q.target_pane_id as string, (leaf) => ({ type: 'split', direction, ratio: 0.5, first: leaf, second: { type: 'pane', pane_id: made } })) as Node;
        return { type: 'pane_info', pane: { pane_id: made, agent_status: 'unknown' } };
      }
      case 'pane.close': {
        const t = tabWith(q.pane_id);
        panes.delete(q.pane_id as string);
        const left = replace(t.root, q.pane_id as string, () => undefined);
        if (left === undefined) tabs.delete(t.id);
        else t.root = left;
        return { type: 'ok' };
      }
      case 'tab.create': {
        const id = `w1:t${nextTab++}`;
        const root = shell();
        tabs.set(id, { id, label: String(q.label ?? ''), ...(typeof q.cwd === 'string' ? { cwd: q.cwd } : {}), ...(q.env === undefined ? {} : { env: q.env as Record<string, string> }), root: { type: 'pane', pane_id: root } });
        if (q.focus !== false) focused = id;
        return { type: 'tab_created', tab: { tab_id: id }, root_pane: { pane_id: root, agent_status: 'unknown' } };
      }
      case 'tab.close': {
        const t = tabs.get(q.tab_id as string);
        if (t === undefined) throw new Refused('not_found', `tab ${String(q.tab_id)} not found`);
        for (const p of panesOf(t.root)) panes.delete(p);
        tabs.delete(t.id);
        return { type: 'ok' };
      }
      case 'pane.scroll': {
        const p = pane(q.pane_id);
        p.scroll.offset = Math.min(p.scroll.max, Math.max(0, Number(q.offset_from_bottom) || 0));
        return { type: 'ok' };
      }
      case 'pane.send_text':
        return take(q.pane_id, { text: String(q.text) });
      case 'pane.send_keys':
        return take(q.pane_id, { keys: q.keys as string[] });
      case 'pane.send_input':
        return take(q.pane_id, { paste: String(q.text), keys: (q.keys as string[] | undefined) ?? [] });
      default:
        throw new Refused('unknown_method', `no method ${method}`);
    }
  };

  const server = createServer((conn) => {
    let got = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      got += chunk;
      const nl = got.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(got.slice(0, nl)) as { id: string; method: string; params?: Record<string, unknown> };
      let reply: unknown;
      try {
        reply = { id: req.id, result: answer(req.method, req.params ?? {}) };
      } catch (err) {
        reply = { id: req.id, error: err instanceof Refused ? { code: err.code, message: err.message } : { code: 'internal', message: String(err) } };
      }
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));

  // The command: `status server --json` says where this herdr answers; `terminal session control <pane> --cols C
  // --rows R` streams two frames at that size, the pane's screen and then a question, and keeps in control.log
  // when it took the pane, each command it is sent and when its stdin ended.
  writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const argv = process.argv.slice(2);',
    `if (argv[0] === 'status') { console.log(JSON.stringify({ status: 'running', running: true, version: ${JSON.stringify(options.version)}, socket: ${JSON.stringify(socket)} })); process.exit(0); }`,
    "const flag = (name) => Number(argv[argv.indexOf(name) + 1]);",
    "const [pane, cols, rows] = [argv[argv.indexOf('control') + 1], flag('--cols'), flag('--rows')];",
    `const note = (what) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id: process.pid, ...what }) + '\\n');`,
    "note({ took: { pane, cols, rows, socket: process.env.HERDR_SOCKET_PATH } });",
    "const frame = (s) => JSON.stringify({ type: 'terminal.frame', seq: 1, encoding: 'ansi', width: cols, height: rows, full: true, bytes: Buffer.from(s).toString('base64') });",
    "console.log(frame('the screen of ' + pane));",
    "console.log(frame('\\u001b[1mDo you want to proceed?\\u001b[0m'));",
    "require('readline').createInterface({ input: process.stdin })",
    "  .on('line', (l) => note({ command: JSON.parse(l) }))",
    "  .on('close', () => { note({ let_go: true }); process.exit(0); });",
  ].join('\n'));
  chmodSync(bin, 0o755);

  return {
    socket,
    bin,
    terminal: (vault, task, at = AGENT_PANE) => ({ vault, task, pane: at, socket, bin, cli: 'claude', since: '2026-10-31T09:00:00Z' }),
    received: (id) => [...(panes.get(id)?.received ?? [])],
    wheels: (id) => {
      // SGR's report of a mouse button, as a program that asked for the mouse reads it: 64 the wheel up, 65 down.
      const typed = (panes.get(id)?.received ?? []).map((r) => ('text' in r ? r.text : '')).join('');
      return [...typed.matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)].filter((m) => m[1] === '64' || m[1] === '65').map((m) => ({ up: m[1] === '64', col: Number(m[2]), row: Number(m[3]) }));
    },
    scrolledBack: (id) => panes.get(id)?.scroll.offset,
    controllers: () => {
      // The last line is left until it ends: a controller may be writing it.
      const written = existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(0, -1) : [];
      const lines = written.map((l) => JSON.parse(l) as { id: number; took?: Omit<Controller, 'commands' | 'holding'>; command?: unknown; let_go?: true });
      const byId = new Map<number, { took: Omit<Controller, 'commands' | 'holding'>; commands: unknown[]; holding: boolean }>();
      for (const l of lines) {
        if (l.took !== undefined) byId.set(l.id, { took: l.took, commands: [], holding: true });
        const c = byId.get(l.id);
        if (c !== undefined && l.command !== undefined) c.commands.push(l.command);
        if (c !== undefined && l.let_go === true) c.holding = false;
      }
      return [...byId.values()].map((c) => ({ ...c.took, commands: c.commands, holding: c.holding }));
    },
    tabs: () => [...tabs.values()].map((t) => ({ ...t, focused: t.id === focused, panes: panesOf(t.root) })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
