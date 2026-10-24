import type { Index, Push, PushFile } from './api';

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
}

export type Unseen = Map<string, PushFile>;

/** What this browser kept, or a start from the vault as it is now. */
export function initSeen(index: Index, stored: unknown): Seen {
  const s = stored as Partial<Seen> | null;
  if (s && typeof s === 'object' && s.tasks) {
    return { init: s.init ?? 0, tasks: s.tasks, problems: s.problems ?? {}, logs: s.logs ?? {}, files: s.files ?? {} };
  }
  const newest = Math.max(0, ...index.tasks.map((t) => t.touched));
  return { init: newest, tasks: {}, problems: {}, logs: {}, files: {} };
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

/** Every task seen up to its newest: Latest's "Mark all seen". */
export function markAllSeen(index: Index, seen: Seen): Seen {
  const tasks = { ...seen.tasks };
  for (const t of index.tasks) tasks[t.id] = Math.max(seenAt(seen, t.id), newestOf(index, t.id));
  return { ...seen, tasks, files: {} };
}

/** Whether a task's log has entries past those last read. */
export function logFresh(seen: Seen, id: string, entries: number | undefined): boolean {
  return entries !== undefined && entries > (seen.logs[id] ?? entries);
}

/** How many tasks have something new: Latest's count, which falls as the last dot of each is cleared. */
export function latestUnseen(index: Index, seen: Seen): number {
  return index.tasks.filter((t) => unseenOf(index, seen, t.id).size > 0).length;
}

/**
 * The pushes Latest lists: every push of a task since its mark, for as long
 * as the task has a dot; its last dot cleared, all of them go.
 */
export function unseenPushes(index: Index, seen: Seen): Push[] {
  const dotted = new Map<string, boolean>();
  const has = (id: string): boolean => {
    if (!dotted.has(id)) dotted.set(id, unseenOf(index, seen, id).size > 0);
    return dotted.get(id) as boolean;
  };
  return index.latest.filter((p) => p.at > seenAt(seen, p.task) && has(p.task));
}

export interface FeedFile {
  readonly task: string;
  readonly path: string;
  readonly sha: string;
  readonly status: 'A' | 'M' | 'D';
  readonly at: number;
}

/** The files of Latest's pushes, each once, in the order prev and next walk them. */
export function feedFiles(index: Index, seen: Seen): FeedFile[] {
  const out: FeedFile[] = [];
  for (const p of unseenPushes(index, seen)) for (const f of p.files) if (f.status !== 'D') out.push({ task: p.task, path: f.path, sha: f.sha, status: f.status, at: p.at });
  const kept = new Set<string>();
  return out.filter((f) => {
    const k = `${f.task}/${f.path}`;
    if (kept.has(k)) return false;
    kept.add(k);
    return true;
  });
}
