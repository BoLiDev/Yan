import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OBSERVE_SINCE, atLeast, observe, paneOf, paneSize, scrollPane, sendInput, sendKeys, sendText, versionOf, type AgentStatus } from '../../externals/herdr/index.js';
import { isYanError } from '../../util/error.js';
import { terminalsOf, type HeldTerminal } from '../../util/machine.js';

/**
 * The terminals the page shows: each task's agent that bare `yan` started in
 * a herdr pane on this machine, while it runs. The page is sent herdr's own
 * live stream of the pane, the bytes a terminal draws, and what `user` types
 * goes back through herdr's socket, so nothing of the agent's screen is read
 * into anything of yan's: a question, a permission, a menu are the agent's
 * own, drawn by it, as in the terminal.
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
  /** herdr's version, and whether it streams a pane (`OBSERVE_SINCE`). */
  readonly herdr: string;
  readonly streams: boolean;
}

/**
 * A mouse wheel, as a terminal reports it to a program that asked for the
 * mouse: SGR's encoding, at the 1-based cell under the pointer.
 */
export function wheelReport(up: boolean, col: number, row: number): string {
  return `\x1b[<${up ? 64 : 65};${Math.max(1, Math.round(col))};${Math.max(1, Math.round(row))}M`;
}

/** A pane drawn this size when herdr does not say its own. */
const FALLBACK_SIZE = { cols: 120, rows: 40 } as const;

export class Terminals {
  /** The states as last asked, for a second: every page asks every two seconds. */
  private asked: { at: number; states: Promise<Record<string, TerminalState>> } | undefined;
  private readonly versions = new Map<string, { at: number; version: Promise<string> }>();
  private readonly streams = new Set<ChildProcess>();

  public constructor(private readonly vault: string) {}

  private held(task: string): HeldTerminal | undefined {
    return terminalsOf(this.vault).find((t) => t.task === task);
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
        const [pane, herdr] = await Promise.all([paneOf(t.socket, t.pane), this.version(t.socket)]);
        const state: TerminalState = { status: pane.agent_status, agent: pane.agent ?? null, cli: t.cli, pane: t.pane, since: t.since, herdr, streams: atLeast(herdr, OBSERVE_SINCE) };
        return [[t.task, state] as const];
      } catch {
        return [];
      }
    })).then((found) => Object.fromEntries(found.flat()));
    this.asked = { at: Date.now(), states };
    return states;
  }

  /**
   * herdr's live stream of the task's pane, as server-sent events: each a
   * frame as herdr wrote it, then `closed` with why, when the stream ends.
   * The pane is drawn its own size, which the page fits to its column.
   */
  public async stream(task: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t = this.held(task);
    if (t === undefined) return void res.writeHead(404).end('this task has no agent in a herdr pane on this machine');
    const version = await this.version(t.socket);
    if (version === '') return void res.writeHead(502).end('herdr is not answering');
    if (!atLeast(version, OBSERVE_SINCE)) return void res.writeHead(409).end(`herdr ${version} cannot stream a pane; ${OBSERVE_SINCE} or later can`);
    const size = (await paneSize(t.socket, t.pane)) ?? FALLBACK_SIZE;

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const child = observe(t.bin, t.socket, t.pane, size.cols, size.rows);
    this.streams.add(child);
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
    child.on('error', (err) => {
      this.streams.delete(child);
      close(`could not start herdr (${t.bin}): ${err.message}`);
    });
    child.on('exit', () => {
      this.streams.delete(child);
      close(said.trim() || 'the pane closed');
    });
    req.on('close', () => child.kill());
  }

  /**
   * `{ task, keys }`: keys by herdr's names; `{ task, text }`: bytes as typed;
   * `{ task, paste, enter }`: text as one paste, then Enter if asked;
   * `{ task, wheel, col, row }`: the mouse wheel turned `wheel` rows, back
   * (less than 0) or on, over a cell.
   */
  public async input(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const t = typeof given.task === 'string' ? this.held(given.task) : undefined;
    if (t === undefined) return void res.writeHead(404).end('this task has no agent in a herdr pane on this machine');
    try {
      if (Array.isArray(given.keys) && given.keys.every((k): k is string => typeof k === 'string') && given.keys.length > 0) await sendKeys(t.socket, t.pane, given.keys);
      else if (typeof given.text === 'string' && given.text !== '') await sendText(t.socket, t.pane, given.text);
      else if (typeof given.paste === 'string') await sendInput(t.socket, t.pane, given.paste, given.enter === true ? ['enter'] : []);
      else if (typeof given.wheel === 'number' && Number.isFinite(given.wheel) && given.wheel !== 0) await this.wheel(t, given.wheel, Number(given.col) || 1, Number(given.row) || 1);
      else return void res.writeHead(400).end('keys, text or paste is needed');
    } catch (err) {
      return void res.writeHead(isYanError(err) && err.code !== 'herdr_unreachable' ? 400 : 502).end(err instanceof Error ? err.message : String(err));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  /**
   * The wheel as herdr turns it in its own window, as far as its socket
   * lets it be told. A pane with rows to scroll back to is a program on the
   * normal screen, as Claude Code is by default: herdr's view of it scrolls,
   * which is what the stream shows. One with none is a full-screen program,
   * as Claude Code in its no-flicker mode, which takes the mouse; it is sent
   * the wheel as a terminal reports it. The socket says nothing of which
   * mouse modes a program asked for, so a program on the normal screen with
   * nothing yet to scroll back to would be sent it too.
   */
  private async wheel(t: HeldTerminal, rows: number, col: number, row: number): Promise<void> {
    const scroll = (await paneOf(t.socket, t.pane)).scroll;
    if (scroll !== undefined && scroll.max_offset_from_bottom > 0) {
      const to = Math.min(scroll.max_offset_from_bottom, Math.max(0, scroll.offset_from_bottom - rows));
      if (to !== scroll.offset_from_bottom) await scrollPane(t.socket, t.pane, to);
      return;
    }
    await sendText(t.socket, t.pane, wheelReport(rows < 0, col, row).repeat(Math.min(Math.abs(rows), 10)));
  }

  /** End every stream, as serve stops. */
  public close(): void {
    for (const child of this.streams) child.kill();
  }
}
