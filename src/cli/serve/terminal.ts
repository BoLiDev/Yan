import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONTROL_SINCE, atLeast, closePane, control, controlCommand, layoutOf, paneOf, panesIn, scrollPane, sendInput, sendKeys, sendText, splitPane, versionOf, type AgentStatus, type Layout } from '../../externals/herdr/index.js';
import { isYanError } from '../../util/error.js';
import { terminalsOf, type HeldTerminal } from '../../util/machine.js';

/**
 * The terminals the page shows: each task's agent that bare `yan` started in
 * a herdr pane on this machine, while it runs. The page is sent herdr's own
 * live stream of the pane, the bytes a terminal draws, and what `user` types
 * goes back through herdr's socket, so nothing of the agent's screen is read
 * into anything of yan's: a question, a permission, a menu are the agent's
 * own, drawn by it, as in the terminal.
 *
 * The stream is a herdr controller of the pane, sized as the page asks, so
 * the agent draws itself for the page's column and fills it, as it fills a
 * terminal window; herdr's own window shows the pane at that size while the
 * page holds it, and its own again once the page lets it go. One controller
 * a pane: the last page to ask takes it.
 *
 * The page shows the agent's whole tab as herdr has it split, so a shell
 * `user` split off beside the agent, in herdr or from the page, is there
 * too, streamed and typed into as the agent is; the page splits a pane and
 * closes one through herdr, so herdr's window and the page are one tab. The
 * agent's own pane is never closed from the page: that would end the agent.
 */

/** What the page is told of a task's terminal. */
export interface TerminalState {
  readonly status: AgentStatus;
  /** The agent herdr finds in the pane, as `claude`; null once it has exited and the pane is a shell again. */
  readonly agent: string | null;
  /** The CLI bare `yan` started. */
  readonly cli: string;
  readonly pane: string;
  readonly since: string;
  /** herdr's version, and whether it streams a pane (`CONTROL_SINCE`). */
  readonly herdr: string;
  readonly streams: boolean;
  /** The agent's tab, as herdr has it split: its pane alone, or it and the panes split off beside it. */
  readonly layout: Layout;
}

/**
 * A mouse wheel, as a terminal reports it to a program that asked for the
 * mouse: SGR's encoding, at the 1-based cell under the pointer.
 */
export function wheelReport(up: boolean, col: number, row: number): string {
  return `\x1b[<${up ? 64 : 65};${Math.max(1, Math.round(col))};${Math.max(1, Math.round(row))}M`;
}

/** A size the page asks for, in cells, within what a terminal could be. */
function cells(value: string | null, least: number, most: number): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= least && n <= most ? n : undefined;
}

export class Terminals {
  /** The states as last asked, for a second: every page asks every two seconds. */
  private asked: { at: number; states: Promise<Record<string, TerminalState>> } | undefined;
  private readonly versions = new Map<string, { at: number; version: Promise<string> }>();
  /** The controller a page holds of each pane, by herdr socket and pane. */
  private readonly controllers = new Map<string, ChildProcess>();

  public constructor(private readonly vault: string) {}

  private held(task: string): HeldTerminal | undefined {
    return terminalsOf(this.vault).find((t) => t.task === task);
  }

  /** The agent's tab as herdr has it split; the agent's pane alone when herdr cannot say. */
  private layout(t: HeldTerminal): Promise<Layout> {
    return layoutOf(t.socket, t.pane).catch(() => ({ pane: t.pane }));
  }

  /** `pane`, when it is the agent's or one in the agent's tab; nothing outside the tab is the page's. */
  private async inTab(t: HeldTerminal, pane: unknown): Promise<string | undefined> {
    if (pane === undefined || pane === null || pane === t.pane) return t.pane;
    return typeof pane === 'string' && panesIn(await this.layout(t)).includes(pane) ? pane : undefined;
  }

  /**
   * herdr's version on a socket, asked once a minute: a herdr updated in
   * place answers on the same socket. One that did not answer is asked
   * again next time, so a herdr restarting is not taken for an old one.
   */
  private version(socket: string): Promise<string> {
    const known = this.versions.get(socket);
    if (known !== undefined && Date.now() - known.at < 60_000) return known.version;
    const version = versionOf(socket).catch(() => {
      this.versions.delete(socket);
      return '';
    });
    this.versions.set(socket, { at: Date.now(), version });
    return version;
  }

  /** Each task's terminal whose pane is there, by task; a pane closed, or a herdr stopped, is left out. */
  public states(): Promise<Record<string, TerminalState>> {
    if (this.asked !== undefined && Date.now() - this.asked.at < 1000) return this.asked.states;
    const states = Promise.all(terminalsOf(this.vault).map(async (t) => {
      try {
        const [pane, herdr, layout] = await Promise.all([paneOf(t.socket, t.pane), this.version(t.socket), this.layout(t)]);
        const state: TerminalState = { status: pane.agent_status, agent: pane.agent ?? null, cli: t.cli, pane: t.pane, since: t.since, herdr, streams: atLeast(herdr, CONTROL_SINCE), layout };
        return [[t.task, state] as const];
      } catch {
        return [];
      }
    })).then((found) => Object.fromEntries(found.flat()));
    this.asked = { at: Date.now(), states };
    return states;
  }

  /**
   * herdr's live stream of a pane of the task's tab, `pane` (the agent's
   * when none is named), as server-sent events, the pane sized `cols` by
   * `rows`: each a frame as herdr wrote it, then `closed` with why, when the
   * stream ends. The page going lets the pane go.
   */
  public async stream(task: string, q: URLSearchParams, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t = this.held(task);
    if (t === undefined) return void res.writeHead(404).end('this task has no agent in a herdr pane on this machine');
    const pane = await this.inTab(t, q.get('pane'));
    if (pane === undefined) return void res.writeHead(404).end('that pane is not in the agent\'s tab');
    const [cols, rows] = [cells(q.get('cols'), 20, 1000), cells(q.get('rows'), 5, 500)];
    if (cols === undefined || rows === undefined) return void res.writeHead(400).end('cols and rows are needed');
    const version = await this.version(t.socket);
    if (version === '') return void res.writeHead(502).end('herdr is not answering');
    if (!atLeast(version, CONTROL_SINCE)) return void res.writeHead(409).end(`herdr ${version} cannot stream a pane; ${CONTROL_SINCE} or later can`);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const child = control(t.bin, t.socket, pane, cols, rows);
    const key = `${t.socket}\n${pane}`;
    this.controllers.get(key)?.stdin?.end();
    this.controllers.set(key, child);
    let said = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      said = (said + chunk).slice(-2000);
    });
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line) => {
      if (line.includes('"terminal.frame"')) res.write(`data: ${line}\n\n`);
    });
    const close = (why: string): void => {
      if (res.writableEnded) return;
      res.write(`event: closed\ndata: ${JSON.stringify({ why })}\n\n`);
      res.end();
    };
    const forget = (): void => {
      if (this.controllers.get(key) === child) this.controllers.delete(key);
    };
    child.on('error', (err) => {
      forget();
      close(`could not start herdr (${t.bin}): ${err.message}`);
    });
    child.on('exit', () => {
      forget();
      close(said.trim() || 'the pane closed');
    });
    child.stdin?.on('error', () => undefined);
    // Its stdin ending is herdr's release, which sizes the pane back; a herdr that does not go is stopped.
    req.on('close', () => {
      forget();
      child.stdin?.end();
      setTimeout(() => child.kill(), 1000).unref();
    });
  }

  /**
   * Into `pane` of the task's tab, the agent's when none is named:
   * `{ task, keys }`: keys by herdr's names; `{ task, text }`: bytes as typed;
   * `{ task, paste, enter }`: text as one paste, then Enter if asked;
   * `{ task, wheel, col, row }`: the mouse wheel turned `wheel` rows, back
   * (less than 0) or on, over a 1-based cell; `{ task, cols, rows }`: the
   * page's room for it, in cells, which the pane is sized to.
   */
  public async input(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const t = typeof given.task === 'string' ? this.held(given.task) : undefined;
    if (t === undefined) return void res.writeHead(404).end('this task has no agent in a herdr pane on this machine');
    try {
      const pane = await this.inTab(t, given.pane);
      if (pane === undefined) return void res.writeHead(404).end('that pane is not in the agent\'s tab');
      if (Array.isArray(given.keys) && given.keys.every((k): k is string => typeof k === 'string') && given.keys.length > 0) await sendKeys(t.socket, pane, given.keys);
      else if (typeof given.text === 'string' && given.text !== '') await sendText(t.socket, pane, given.text);
      else if (typeof given.paste === 'string') await sendInput(t.socket, pane, given.paste, given.enter === true ? ['enter'] : []);
      else if (typeof given.wheel === 'number' && Number.isFinite(given.wheel) && given.wheel !== 0) await this.wheel(t, pane, Math.trunc(given.wheel), Number(given.col) || 1, Number(given.row) || 1);
      else if (given.cols !== undefined || given.rows !== undefined) {
        const [cols, rows] = [cells(String(given.cols), 20, 1000), cells(String(given.rows), 5, 500)];
        const held = this.controllers.get(`${t.socket}\n${pane}`);
        if (cols === undefined || rows === undefined || held === undefined) return void res.writeHead(409).end('no page holds this pane at a size it can take');
        held.stdin?.write(`${controlCommand({ resize: { cols, rows } })}\n`);
      }
      else return void res.writeHead(400).end('keys, text or paste is needed');
    } catch (err) {
      return void res.writeHead(isYanError(err) && err.code !== 'herdr_unreachable' ? 400 : 502).end(err instanceof Error ? err.message : String(err));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  /**
   * The wheel as herdr turns it in its own window. A page holding the pane
   * hands it to its controller, and herdr knows what the program asked for:
   * the mouse, the arrows, or its own history scrolled. With none, as far as
   * the socket lets it be told: a pane with rows to scroll back to is a
   * program on the normal screen, and herdr's view of it scrolls; one with
   * none is taken for a full-screen program that takes the mouse, as Claude
   * Code in its no-flicker mode, and is sent the wheel as a terminal reports
   * it.
   */
  private async wheel(t: HeldTerminal, pane: string, rows: number, col: number, row: number): Promise<void> {
    const held = this.controllers.get(`${t.socket}\n${pane}`);
    if (held?.stdin?.writable === true) {
      held.stdin.write(`${controlCommand({ scroll: rows, col: col - 1, row: row - 1 })}\n`);
      return;
    }
    const scroll = (await paneOf(t.socket, pane)).scroll;
    if (scroll !== undefined && scroll.max_offset_from_bottom > 0) {
      const to = Math.min(scroll.max_offset_from_bottom, Math.max(0, scroll.offset_from_bottom - rows));
      if (to !== scroll.offset_from_bottom) await scrollPane(t.socket, pane, to);
      return;
    }
    await sendText(t.socket, pane, wheelReport(rows < 0, col, row).repeat(Math.min(Math.abs(rows), 10)));
  }

  /**
   * `{ task, pane, direction }`: a shell split off `pane` of the task's tab
   * (the agent's when none is named), to its `right` or `down` below it,
   * through herdr, so herdr's window has it too. Answers the new pane.
   */
  public async split(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const t = typeof given.task === 'string' ? this.held(given.task) : undefined;
    if (t === undefined) return void res.writeHead(404).end('this task has no agent in a herdr pane on this machine');
    if (given.direction !== 'right' && given.direction !== 'down') return void res.writeHead(400).end('direction is right or down');
    try {
      const pane = await this.inTab(t, given.pane);
      if (pane === undefined) return void res.writeHead(404).end('that pane is not in the agent\'s tab');
      const made = await splitPane(t.socket, pane, given.direction);
      this.asked = undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ pane: made }));
    } catch (err) {
      res.writeHead(isYanError(err) && err.code !== 'herdr_unreachable' ? 400 : 502).end(err instanceof Error ? err.message : String(err));
    }
  }

  /** `{ task, pane }`: a pane split off in the task's tab closed through herdr, and what runs in it; never the agent's own. */
  public async closeSplit(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const t = typeof given.task === 'string' ? this.held(given.task) : undefined;
    if (t === undefined) return void res.writeHead(404).end('this task has no agent in a herdr pane on this machine');
    if (given.pane === t.pane) return void res.writeHead(400).end('the agent\'s own pane is not closed from the page');
    try {
      const pane = typeof given.pane === 'string' ? await this.inTab(t, given.pane) : undefined;
      if (pane === undefined) return void res.writeHead(404).end('that pane is not in the agent\'s tab');
      await closePane(t.socket, pane);
      this.asked = undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    } catch (err) {
      res.writeHead(isYanError(err) && err.code !== 'herdr_unreachable' ? 400 : 502).end(err instanceof Error ? err.message : String(err));
    }
  }

  /** End every stream, as serve stops. */
  public close(): void {
    for (const child of this.controllers.values()) child.kill();
    this.controllers.clear();
  }
}
