import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asRecord } from '../../util/narrow.js';
import { samePath } from '../../util/paths.js';
import type { AgentFacts, HarnessEnv, Spoke } from './types.js';

/**
 * When an agent last wrote to its own session file, one adapter per harness
 * yan runs. Every adapter answers `undefined` for every way of not knowing —
 * no session id, no directory, no file, a file it cannot read — and never
 * throws: the caller falls to its next rung.
 */

/** A dispatched agent is not started earlier than yan recorded, give or take this. */
const START_SLACK_MS = 60_000;

function mtimeOf(file: string): number | undefined {
  try {
    const s = statSync(file);
    return s.isFile() ? s.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The newest of `files` that exists. */
function newest(files: readonly string[]): Spoke | undefined {
  let best: Spoke | undefined;
  for (const file of files) {
    const at = mtimeOf(file);
    if (at !== undefined && (best === undefined || at > best.at)) best = { at, file };
  }
  return best;
}

// --- claude ------------------------------------------------------------------

/**
 * The directory name Claude files a project's sessions under: the path with
 * every character that is not a letter or a digit turned into `-`. Claude
 * shortens very long ones, which the scan in `claudeFiles` covers.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

interface ClaudeRegistryEntry {
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly startedAt: number;
}

/**
 * `~/.claude/sessions/<pid>.json`, which a running Claude keeps for itself:
 * its pid, session id, directory and start time. Herdr reports a session id
 * only when its Claude integration is installed, so this is how the id is
 * found without it.
 */
function claudeRegistry(home: string): ClaudeRegistryEntry[] {
  const dir = join(home, '.claude', 'sessions');
  const found: ClaudeRegistryEntry[] = [];
  for (const name of entries(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = asRecord(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      const { pid, sessionId, cwd, startedAt } = raw;
      if (typeof pid !== 'number' || typeof sessionId !== 'string' || sessionId === '') continue;
      found.push({
        pid,
        sessionId,
        cwd: typeof cwd === 'string' ? cwd : '',
        startedAt: typeof startedAt === 'number' ? startedAt : 0,
      });
    } catch {
      // Half-written or not Claude's: not this agent.
    }
  }
  return found;
}

/**
 * The session id and directory of the agent `facts` describes, from the
 * registry: the child of `parentPid` when that is known, else the newest
 * session started in `cwd` no earlier than the agent was.
 */
function claudeSessionOf(facts: AgentFacts, env: HarnessEnv): { id: string; cwd: string } | undefined {
  const registry = claudeRegistry(env.home);
  if (registry.length === 0) return undefined;

  if (facts.parentPid !== undefined) {
    const parents = env.processes();
    const child = registry.find((e) => parents.get(e.pid) === facts.parentPid);
    if (child !== undefined) return { id: child.sessionId, cwd: child.cwd };
  }

  const cwd = facts.cwd;
  if (cwd === undefined || cwd === '') return undefined;
  const from = facts.startedAt === undefined ? -Infinity : facts.startedAt - START_SLACK_MS;
  const here = registry
    .filter((e) => e.cwd !== '' && samePath(e.cwd, cwd) && e.startedAt >= from)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  return here === undefined ? undefined : { id: here.sessionId, cwd: here.cwd };
}

/**
 * Every file a Claude session writes to: `<slug>/<id>.jsonl`, appended on
 * every message and tool call, and one `<slug>/<id>/subagents/agent-*.jsonl`
 * per sub-agent, which writes there rather than into the parent's file.
 * When the slug directory does not hold the session, every project is
 * searched for it.
 */
function claudeFiles(home: string, id: string, cwd: string | undefined): string[] {
  const projects = join(home, '.claude', 'projects');
  const inProject = (dir: string): string[] => [
    join(dir, `${id}.jsonl`),
    ...entries(join(dir, id, 'subagents'))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, id, 'subagents', f)),
  ];

  if (cwd !== undefined && cwd !== '') {
    const dir = join(projects, claudeProjectSlug(cwd));
    if (mtimeOf(join(dir, `${id}.jsonl`)) !== undefined) return inProject(dir);
  }
  for (const project of entries(projects)) {
    const dir = join(projects, project);
    if (mtimeOf(join(dir, `${id}.jsonl`)) !== undefined) return inProject(dir);
  }
  return [];
}

export function claudeSpoke(facts: AgentFacts, env: HarnessEnv): Spoke | undefined {
  let id = facts.sessionId;
  let cwd = facts.cwd;
  if (id === undefined || id === '') {
    const found = claudeSessionOf(facts, env);
    if (found === undefined) return undefined;
    id = found.id;
    cwd = found.cwd === '' ? cwd : found.cwd;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return undefined;
  return newest(claudeFiles(env.home, id, cwd));
}

// --- agy ---------------------------------------------------------------------

/**
 * Antigravity CLI keeps one folder per conversation, flat, with no record of
 * the workspace it ran in:
 *
 *   ~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
 *
 * one line per step, with `transcript_full.jsonl` beside it holding what the
 * first one truncated. Nothing on disk maps a directory to a conversation, so
 * without the id Herdr reports there is no file to read. Taken from the
 * documentation, not from an installed agy.
 */
export function agySpoke(facts: AgentFacts, env: HarnessEnv): Spoke | undefined {
  const id = facts.sessionId;
  if (id === undefined || !/^[A-Za-z0-9._-]+$/.test(id)) return undefined;
  const logs = join(env.home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs');
  return newest([join(logs, 'transcript.jsonl'), join(logs, 'transcript_full.jsonl')]);
}

// --- codex -------------------------------------------------------------------

/** Not read: codex is not run on the machines yan was built on, and `user` left it out. */
export function codexSpoke(): Spoke | undefined {
  return undefined;
}

// --- the entry point ---------------------------------------------------------

/** pid → parent pid, from `ps`. Empty where there is no `ps`. */
function processTable(): ReadonlyMap<number, number> {
  const table = new Map<number, number>();
  if (process.platform === 'win32') return table;
  try {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    for (const line of (r.stdout ?? '').split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid !== undefined && ppid !== undefined && Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid);
    }
  } catch {
    // No table: the parent match is skipped.
  }
  return table;
}

/** The real home directory and process table, the table read at most once. */
export function harnessEnv(): HarnessEnv {
  let table: ReadonlyMap<number, number> | undefined;
  return {
    home: homedir(),
    processes: () => (table ??= processTable()),
  };
}

/**
 * When the agent `facts` describes last wrote to its session file, or
 * `undefined` when its harness keeps none yan can find. Never throws.
 */
export function lastSpoke(facts: AgentFacts, env: HarnessEnv = harnessEnv()): Spoke | undefined {
  try {
    if (facts.kind === 'claude') return claudeSpoke(facts, env);
    if (facts.kind === 'agy') return agySpoke(facts, env);
    if (facts.kind === 'codex') return codexSpoke();
  } catch {
    // Whatever went wrong, the answer is "not known".
  }
  return undefined;
}
