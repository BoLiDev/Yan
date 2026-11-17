import type { Index, PushFile } from './api';

/**
 * What is new since the last look, kept in this browser only: one person,
 * one machine. A task's mark is the newest commit time seen in it, so what
 * another machine pushed while this one was away counts as new when it
 * arrives. Past the mark, each file is looked at on its own, as GitHub's
 * Viewed: its dot goes when it is opened, or clicked in when a push changed
 * it while it was open, and comes back when it changes again. Nothing is
 * seen by the page being open, in front or not. Once none of a task's files
 * has a dot, the mark moves up to its newest.
 *
 * Every function here is pure: it reads a `Seen` and returns a new one.
 */
export interface Seen {
  /** The newest time in the vault when this browser first opened the page: older is not new. */
  readonly init: number;
  readonly tasks: Readonly<Record<string, number>>;
  /** The problem.md sha last shown, per task. */
  readonly problems: Readonly<Record<string, string>>;
  /** How many log entries were last read, per task. */
  readonly logs: Readonly<Record<string, number>>;
  /** Per task, each file looked at past the mark, with the change it was looked at in. */
  readonly files: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Per task, the time of its agent's last change looked at in its terminal; a page from before kept none. */
  readonly agents?: Readonly<Record<string, number>>;
}

export type Unseen = Map<string, PushFile>;

/** What this browser kept, or a start from the vault as it is now. */
export function initSeen(index: Index, stored: unknown): Seen {
  const s = stored as Partial<Seen> | null;
  if (s && typeof s === 'object' && s.tasks) {
    return { init: s.init ?? 0, tasks: s.tasks, problems: s.problems ?? {}, logs: s.logs ?? {}, files: s.files ?? {}, agents: s.agents ?? {} };
  }
  const newest = Math.max(0, ...index.tasks.map((t) => t.touched));
  return { init: newest, tasks: {}, problems: {}, logs: {}, files: {}, agents: {} };
}

export const seenAt = (seen: Seen, id: string): number => seen.tasks[id] ?? seen.init;

/** The newest time anything arrived in a task: its files, and every push in the feed, deletions included. */
export function newestOf(index: Index, id: string): number {
  const t = index.tasks.find((x) => x.id === id);
  return Math.max(t?.touched ?? 0, t?.added[0] ?? 0, ...index.latest.filter((p) => p.task === id).map((p) => p.at));
}

/**
 * The files of a task with a dot: added or changed since its mark and not
 * looked at since, path → the file as it was last changed, with that
 * change's time. A push gathers the commits of a quarter of an hour, and a
 * file looked at early in it stays seen as later ones join. A file deleted
 * since has nothing to look at.
 */
/** No file with a dot: what a task has when the marks are turned off. */
export const NOTHING_UNSEEN: Unseen = new Map();

export function unseenOf(index: Index, seen: Seen, id: string): Unseen {
  const base = seenAt(seen, id);
  const looked = seen.files[id] ?? {};
  const where = new Set<string>();
  const out: Unseen = new Map();
  // Newest push first, so a file's first status is its last.
  for (const p of index.latest) {
    if (p.task !== id || p.at <= base) continue;
    for (const f of p.files) {
      if (where.has(f.path)) continue;
      where.add(f.path);
      const at = f.at ?? p.at;
      if (f.status !== 'D' && at > base && at > (looked[f.path] ?? 0)) out.set(f.path, { ...f, at });
    }
  }
  return out;
}

/** A task with no dot left is seen up to its newest. */
function settle(index: Index, seen: Seen, id: string): Seen {
  if (unseenOf(index, seen, id).size) return seen;
  const { [id]: _, ...files } = seen.files;
  return { ...seen, tasks: { ...seen.tasks, [id]: Math.max(seenAt(seen, id), newestOf(index, id)) }, files };
}

/** Looked at: `path` of task `id` loses its dot. Null when it had none. */
export function markLooked(index: Index, seen: Seen, id: string, path: string | undefined): Seen | null {
  const was = path ? unseenOf(index, seen, id).get(path) : undefined;
  if (!was || !path) return null;
  return settle(index, { ...seen, files: { ...seen.files, [id]: { ...seen.files[id], [path]: was.at } } }, id);
}

/** 全部已读: every dot of a task gone at once, its log's too. */
export function markTaskRead(index: Index, seen: Seen, id: string, logEntries: number | undefined): Seen {
  const { [id]: _, ...files } = seen.files;
  return {
    ...seen,
    tasks: { ...seen.tasks, [id]: Math.max(seenAt(seen, id), newestOf(index, id)) },
    files,
    logs: logEntries === undefined ? seen.logs : { ...seen.logs, [id]: logEntries },
  };
}

/** Whether a task's log has entries past those last read. */
export function logFresh(seen: Seen, id: string, entries: number | undefined): boolean {
  return entries !== undefined && entries > (seen.logs[id] ?? entries);
}

