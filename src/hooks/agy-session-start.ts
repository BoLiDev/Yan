import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';
import { readStdin } from './stdin.js';

/**
 * Agy's stand-in for the `SessionStart` hook it does not have. Agy-only:
 * Claude and Codex fire a real `SessionStart` once when a session opens, and
 * their hook configs run `yan session-start` directly, so nothing here is on
 * their path.
 *
 * Agy's lifecycle has no such event — its five are the two tool-use pairs and
 * `Stop` — so the nearest place is `PreInvocation`, which fires before every
 * model call. That is far too often, and `invocationNum` cannot narrow it: it
 * is 0 on the first turn and 0 again on the next, so it counts something other
 * than turns. `conversationId` is what actually holds still across a
 * conversation and changes when a new one begins, so it — not a counter — is
 * what makes this run once. The id last handled is kept in the task's
 * `run/agy-session`; that marker is the whole of what touches the disk.
 *
 * The rebuild is handed to the model as an `ephemeralMessage`, which is agy's
 * transient system message: yan reads its own startup report rather than
 * having it printed past it into a pane nobody is reading.
 *
 * The picture it rebuilds is the main agent's. A shift working on the yan
 * repository inherits this repository's hook registrations and would have that
 * picture injected into its own context; `YAN_SID` is set in a shift's
 * environment and never in the main agent's, so it is what tells them apart.
 *
 * Every path prints an object, because a `PreInvocation` hook that says
 * nothing is a hook whose contract was broken. Nothing here is worth failing a
 * turn for: a session that starts without its picture is a session that runs
 * `yan session-start` by hand.
 */

interface SessionStartIo {
  /** stderr: where a failure goes, for the agy log rather than the model. */
  readonly note: (line: string) => void;
  /** stdout: the `PreInvocation` decision object. */
  readonly say: (line: string) => void;
  /** The harness payload. */
  readonly stdin: () => Promise<string>;
}

/** The conversation this payload belongs to, or `''` when it does not say. */
function conversationOf(payload: string): string {
  if (payload === '') return '';
  try {
    const parsed: unknown = JSON.parse(payload);
    const id = (parsed as { conversationId?: unknown }).conversationId;
    return typeof id === 'string' ? id : '';
  } catch {
    // Not JSON, or half of it. No id is the safe reading.
    return '';
  }
}

/**
 * The task whose picture this hook is for, or `null` when it is not the main
 * agent's hook at all: a shift's agy, or one started outside any task.
 */
function mainAgentTask(): Task | null {
  // A shift's agy, not the main agent's: the task picture is not its business.
  if ((process.env.YAN_SID ?? '') !== '') return null;

  const id = process.env.YAN_TASK ?? '';
  if (id === '' || !Task.isId(id)) return null;
  const task = new Task(id);
  return task.exists() ? task : null;
}

/**
 * The same `yan session-start` that Claude and Codex run straight from their
 * `SessionStart` hook, spawned here so its report can be handed back to agy in
 * process. Returns the report, or `''` with the reason already noted.
 */
function rebuildPicture(io: SessionStartIo): string {
  const home = yanHome();
  const yan = join(home, 'dist', 'cli', 'yan.js');
  if (!existsSync(yan)) {
    io.note(`cannot find ${yan} - run 'npm run build'; the session opened without its picture`);
    return '';
  }

  const rebuilt = spawnSync(process.execPath, [yan, 'session-start'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, YAN_HOME: home },
    windowsHide: true,
  });

  if (rebuilt.error !== undefined) {
    io.note(`could not run 'yan session-start': ${rebuilt.error.message}`);
    return '';
  }
  if (rebuilt.status !== 0) {
    io.note(`'yan session-start' exited ${String(rebuilt.status)}: ${(rebuilt.stderr ?? '').trim()}`);
  }
  return (rebuilt.stdout ?? '').trim();
}

export async function agySessionStart(io: SessionStartIo): Promise<number> {
  /** Inject nothing, and let the invocation proceed. */
  const nothing = (): number => {
    io.say('{}');
    return 0;
  };

  const task = mainAgentTask();
  if (task === null) return nothing();

  const conversation = conversationOf(await io.stdin());
  if (conversation === '') return nothing();

  const marker = join(task.dir, 'run', 'agy-session');
  try {
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === conversation) return nothing();
  } catch {
    // Unreadable is treated as absent: rebuilding twice costs seconds, and
    // never rebuilding costs yan its picture of the task.
  }

  // Claimed before the rebuild rather than after it. A `session-start` that
  // failed once will fail again, and retrying it on every model call would
  // spend the session's whole first minute in a hook.
  try {
    mkdirSync(join(task.dir, 'run'), { recursive: true });
    writeFileSync(marker, `${conversation}\n`);
  } catch (err) {
    io.note(`could not record the session marker: ${String(err)}`);
  }

  const report = rebuildPicture(io);
  if (report === '') return nothing();

  io.say(JSON.stringify({ injectSteps: [{ ephemeralMessage: report }] }));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && /[\\/]agy-session-start\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  agySessionStart({
    note: (line) => process.stderr.write(`yan session-start: ${line}\n`),
    say: (line) => process.stdout.write(`${line}\n`),
    stdin: () => readStdin(Number(process.env.YAN_HOOK_STDIN_TIMEOUT ?? '1') * 1000),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // A hook that crashes must not wedge the session: say the empty object
      // by hand, because the normal paths never ran.
      process.stderr.write(
        `yan session-start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.stdout.write('{}\n');
      process.exitCode = 0;
    });
}
