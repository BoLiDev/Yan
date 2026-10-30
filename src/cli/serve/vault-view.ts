import { createHash } from 'node:crypto';
import { asRecord, asString, recordOrNone } from '../../util/narrow.js';
import { repoKey } from '../../util/repo-key.js';
import { YanError } from '../../util/error.js';
import { BRANCH_MARKS, branchMark, type BranchMark } from '../../records/task/index.js';
import { BlobReader, gitAsync } from './blobs.js';

/**
 * The vault as `yan serve` shows it: every task at one commit, and when each
 * of its files arrived, read from git objects and never from the work tree.
 *
 * What a file "added" means is the commit that last added it, so a file
 * deleted and written again counts as new. Times are Unix seconds and the
 * page formats them, in whatever zone the browser is in.
 */

export interface TreeEntry {
  /** From the vault's root, `tasks/t124/artifacts/c4/x.png`. */
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}

export interface FileChange {
  readonly status: string;
  readonly path: string;
}

export interface Commit {
  readonly sha: string;
  readonly at: number;
  readonly subject: string;
  readonly files: readonly FileChange[];
}

interface FileTimes {
  added: number;
  changed: number;
  commit: string;
}

/** One artifact, its path from the task's `artifacts/`. */
export interface ArtifactFile {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly added: number;
  readonly changed: number;
  readonly commit: string;
}

export interface TaskSummary {
  readonly id: string;
  /** "" when task.json cannot be read. */
  readonly title: string;
  readonly state: string;
  readonly createdAt: string | null;
  readonly closedAt: string | null;
  readonly repos: readonly { readonly name: string; readonly branch: string | null; readonly earlier: readonly string[]; readonly abandoned: readonly string[] }[];
  readonly deliverables: { readonly done: number; readonly todo: number; readonly abandoned: number };
  /** Its agents running elsewhere, as on a cloud platform: its run resources that are web links, by name. */
  readonly agents: readonly (readonly [string, string])[];
  readonly artifacts: number;
  /** When each shown artifact was added, newest first: the page counts what is new against its own last visit. */
  readonly added: readonly number[];
  /** The newest commit that touched anything of the task's. */
  readonly touched: number;
  /**
   * Its files as they are now, every path and sha hashed: what the page
   * reloads a task by, so a push to one task leaves the others as they are.
   */
  readonly rev: string;
}

export interface Push {
  readonly task: string;
  /** The newest commit's time. */
  readonly at: number;
  /**
   * A deleted file has no sha: there is nothing left to show. `at` is the
   * newest commit of the push that touched it, so a file looked at stays seen
   * when later commits join its push.
   */
  readonly files: readonly { readonly path: string; readonly sha: string; readonly status: 'A' | 'M' | 'D'; readonly at: number }[];
}

export interface Deliverable {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly doneAt: string | null;
  readonly reason: string | null;
}

export interface LogEntry {
  readonly day: string;
  readonly type: string;
  readonly text: string;
}

export interface TaskDetail {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly createdAt: string | null;
  readonly closedAt: string | null;
  readonly reason: string | null;
  readonly repos: readonly { readonly url: string; readonly name: string; readonly branch: string | null; readonly earlier: readonly string[]; readonly abandoned: readonly string[]; readonly bases: Readonly<Record<string, string>> }[];
  readonly deliverables: readonly Deliverable[];
  readonly resources: readonly (readonly [string, string])[];
  /** Each resource's kind by its name, as task.json keeps them; one with none is general. */
  readonly resourceKinds: Readonly<Record<string, string>>;
  readonly problem: { readonly path: string; readonly sha: string; readonly text: string; readonly changed: number } | null;
  readonly log: { readonly sha: string; readonly entries: readonly LogEntry[]; readonly changed: number } | null;
  readonly files: readonly ArtifactFile[];
  /** What is kept out of the tree, by the folder or file that hides it. */
  readonly hidden: readonly { readonly name: string; readonly count: number }[];
}

/**
 * Folders nobody opens to look at: a browser profile a test left behind,
 * installed packages, anything starting with a dot. `undefined` when the path
 * is shown, otherwise the part of it that hides it.
 */
export function hiddenBy(rel: string): string | undefined {
  for (const part of rel.split('/')) {
    if (part.startsWith('.') || part === 'node_modules' || part === '__pycache__' || /(^|-)profile$|^chrome-prof/.test(part)) {
      return part;
    }
  }
  return undefined;
}

/** A path git printed in quotes because of a tab, a newline, a quote or a backslash in it. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  return path.slice(1, -1).replace(/\\(.)/g, (_, c: string) => ({ t: '\t', n: '\n' } as Record<string, string>)[c] ?? c);
}

/** `git log` of `range`, newest first, with what each commit did to each file. */
export async function readHistory(dir: string, range: readonly string[], under: string): Promise<Commit[]> {
  const r = await gitAsync(dir, ['log', '--format=%x1e%H%x1f%ct%x1f%s', '--name-status', '--no-renames', ...range, '--', under]);
  if (r.code !== 0) throw new YanError('serve_git', `git log in ${dir} failed: ${r.stderr.trim()}`);
  const commits: Commit[] = [];
  for (const record of r.stdout.split('\x1e').slice(1)) {
    const lines = record.split(/\r?\n/);
    const [sha = '', at = '0', subject = ''] = (lines[0] ?? '').split('\x1f');
    const files = lines
      .slice(1)
      .filter((l) => l.includes('\t'))
      .map((l) => {
        const [status = '', ...rest] = l.split('\t');
        return { status: status.charAt(0), path: unquote(rest.join('\t')) };
      });
    commits.push({ sha, at: Number(at), subject, files });
  }
  return commits;
}

/** Every blob under `under` at `commit`. */
export async function listTree(dir: string, commit: string, under: string): Promise<TreeEntry[]> {
  const r = await gitAsync(dir, ['ls-tree', '-r', '-l', '-z', commit, '--', under]);
  if (r.code !== 0) throw new YanError('serve_git', `git ls-tree in ${dir} failed: ${r.stderr.trim()}`);
  const entries: TreeEntry[] = [];
  for (const line of r.stdout.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    // `<mode> <type> <sha> <size>`, the size right-aligned.
    const [, type, sha, size] = line.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || sha === undefined) continue;
    entries.push({ path: line.slice(tab + 1), sha, size: Number(size) || 0 });
  }
  return entries;
}

/** `- MM-DD  type  text`; a line that is not one is carried on the entry before it. */
export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^- (\d{2}-\d{2})\s+([a-z]+)\s+(.*)$/.exec(line);
    if (m !== null) {
      entries.push({ day: m[1] as string, type: m[2] as string, text: (m[3] as string).trim() });
    } else if (line.trim() !== '' && entries.length > 0) {
      const last = entries.pop() as LogEntry;
      entries.push({ ...last, text: `${last.text}\n${line.trim()}` });
    }
  }
  return entries;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `earlierBranches`, oldest first, as names: every branch the task kept but the last its tree was on. */
function branchList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((b): b is string => typeof b === 'string' && b.trim() !== '').map((b) => b.trim()))] : [];
}

/**
 * Which of a repository's branches the task marks given up, by the rule
 * task.json is read by (`branchMark`); merged is told from git, by the branch's view.
 */
function abandonedOf(branch: string | null, earlier: readonly string[], raw: unknown): string[] {
  const branchMarks: Record<string, BranchMark> = {};
  for (const [name, mark] of Object.entries(recordOrNone(raw) ?? {})) {
    if ((BRANCH_MARKS as readonly unknown[]).includes(mark)) branchMarks[name.trim()] = mark as BranchMark;
  }
  const repo = { ...(branch === null ? {} : { branch }), branchMarks };
  return [...(branch === null ? [] : [branch]), ...earlier].filter((name) => branchMark(repo, name) === 'abandoned');
}

/** `branchBases`: where each branch last met the default branch, leaving out what is not a full commit sha. */
function basesOf(raw: unknown): Record<string, string> {
  const bases: Record<string, string> = {};
  for (const [name, sha] of Object.entries(recordOrNone(raw) ?? {})) {
    if (typeof sha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha.trim())) bases[name.trim()] = sha.trim();
  }
  return bases;
}

function repoName(url: string): string {
  return repoKey(url).split('/').pop() ?? url;
}

interface TaskJson {
  readonly title: string;
  readonly state: string;
  readonly createdAt: string | null;
  readonly closedAt: string | null;
  readonly reason: string | null;
  readonly repos: readonly { readonly url: string; readonly name: string; readonly branch: string | null; readonly earlier: readonly string[]; readonly abandoned: readonly string[]; readonly bases: Readonly<Record<string, string>> }[];
  readonly deliverables: readonly Deliverable[];
  readonly resources: readonly (readonly [string, string])[];
  /** Each resource's kind by its name, as task.json keeps them; one with none is general. */
  readonly resourceKinds: Readonly<Record<string, string>>;
}

/** What can be read of a task.json, whatever shape it is in; nothing in it is required. */
export function readTaskJson(raw: unknown): TaskJson {
  const r = asRecord(raw);
  const repos = Array.isArray(r.repos)
    ? r.repos.map((x) => recordOrNone(x)).filter((x) => x !== undefined && text(x.url) !== null)
    : [];
  const deliverables = Array.isArray(r.deliverables) ? r.deliverables.map((x) => asRecord(x)) : [];
  return {
    title: asString(r.title),
    state: text(r.state) ?? 'open',
    createdAt: text(r.createdAt),
    closedAt: text(r.closedAt),
    reason: text(r.reason),
    repos: repos.map((x) => {
      const branch = text(x!.branch);
      const earlier = branchList(x!.earlierBranches).filter((b) => b !== branch);
      return { url: x!.url as string, name: repoName(x!.url as string), branch, earlier, abandoned: abandonedOf(branch, earlier, x!.branchMarks), bases: basesOf(x!.branchBases) };
    }),
    deliverables: deliverables.map((d) => ({
      id: asString(d.id),
      text: asString(d.text),
      status: text(d.status) ?? 'todo',
      doneAt: text(d.doneAt),
      reason: text(d.reason),
    })),
    resources: Object.entries(asRecord(r.resources)).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as const),
    resourceKinds: Object.fromEntries(Object.entries(asRecord(r.resourceKinds)).filter((e): e is [string, string] => typeof e[1] === 'string')),
  };
}

/** Commits in a row on one task, this close together, are one push. */
const PUSH_GAP_S = 15 * 60;
const MAX_PUSHES = 200;

interface TaskFiles {
  json?: TreeEntry;
  problem?: TreeEntry;
  brief?: TreeEntry;
  log?: TreeEntry;
  artifacts: TreeEntry[];
}

/**
 * The vault at one commit. `load` moves it to another, reading only the
 * history it has not read yet when the new commit descends from the old.
 */
export class VaultView {
  public readonly blobs: BlobReader;
  /** Newest first. */
  private commits: Commit[] = [];
  private times = new Map<string, FileTimes>();
  private byPath = new Map<string, TreeEntry>();
  private tasks = new Map<string, TaskFiles>();
  private parsed = new Map<string, TaskJson>();
  private loaded: string | undefined;

  public constructor(public readonly dir: string) {
    this.blobs = new BlobReader(dir);
  }

  public get commit(): string | undefined {
    return this.loaded;
  }

  public async load(commit: string): Promise<void> {
    if (commit === this.loaded) return;
    const descends = this.loaded !== undefined && (await gitAsync(this.dir, ['merge-base', '--is-ancestor', this.loaded, commit])).code === 0;
    const fresh = await readHistory(this.dir, descends ? [`${this.loaded}..${commit}`] : [commit], 'tasks');
    if (descends) {
      this.commits = [...fresh, ...this.commits];
    } else {
      this.commits = fresh;
      this.times = new Map();
    }
    for (const c of [...fresh].reverse()) {
      for (const f of c.files) {
        const t = this.times.get(f.path);
        if (f.status === 'D') this.times.delete(f.path);
        else if (f.status === 'A' || t === undefined) this.times.set(f.path, { added: c.at, changed: c.at, commit: c.sha });
        else this.times.set(f.path, { ...t, changed: c.at, commit: c.sha });
      }
    }

    const entries = await listTree(this.dir, commit, 'tasks');
    this.byPath = new Map(entries.map((e) => [e.path, e]));
    this.tasks = new Map();
    for (const e of entries) {
      const [, id, name, ...rest] = e.path.split('/');
      if (id === undefined || name === undefined) continue;
      let t = this.tasks.get(id);
      if (t === undefined) this.tasks.set(id, (t = { artifacts: [] }));
      if (rest.length > 0) {
        if (name === 'artifacts') t.artifacts.push(e);
      } else if (name === 'task.json') t.json = e;
      else if (name === 'problem.md') t.problem = e;
      else if (name === 'brief.md') t.brief = e;
      else if (name === 'log.md') t.log = e;
    }
    await Promise.all([...this.tasks.values()].map((t) => (t.json === undefined ? undefined : this.taskJson(t.json))));
    this.loaded = commit;
  }

  public entry(path: string): TreeEntry | undefined {
    return this.byPath.get(path);
  }

  public hasTask(id: string): boolean {
    return this.tasks.has(id);
  }

  public index(): { tasks: TaskSummary[]; latest: Push[] } {
    const tasks: TaskSummary[] = [];
    for (const [id, files] of [...this.tasks].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
      if (files.json === undefined) continue;
      const json = this.parsed.get(files.json.sha) ?? readTaskJson({});
      const shown = files.artifacts.filter((e) => hiddenBy(this.rel(id, e.path)) === undefined);
      let touched = 0;
      const rev = createHash('sha1');
      for (const e of [files.json, files.problem, files.brief, files.log, ...files.artifacts]) {
        if (e === undefined) continue;
        touched = Math.max(touched, this.times.get(e.path)?.changed ?? 0);
        rev.update(`${e.path}\0${e.sha}\n`);
      }
      const count = (status: string): number => json.deliverables.filter((d) => d.status === status).length;
      tasks.push({
        id,
        title: json.title,
        state: json.state,
        createdAt: json.createdAt,
        closedAt: json.closedAt,
        repos: json.repos.map((r) => ({ name: r.name, branch: r.branch, earlier: r.earlier, abandoned: r.abandoned })),
        deliverables: { done: count('done'), todo: count('todo'), abandoned: count('abandoned') },
        agents: json.resources.filter(([name, where]) => json.resourceKinds[name] === 'run' && /^https?:\/\//i.test(where)),
        artifacts: shown.length,
        added: shown.map((e) => this.times.get(e.path)?.added ?? 0).sort((a, b) => b - a),
        touched,
        rev: rev.digest('hex').slice(0, 16),
      });
    }
    return { tasks, latest: this.pushes() };
  }

  public async task(id: string): Promise<TaskDetail | undefined> {
    const files = this.tasks.get(id);
    if (files === undefined) return undefined;
    const json = files.json === undefined ? readTaskJson({}) : await this.taskJson(files.json);
    const problemEntry = files.problem ?? files.brief;
    const [problemText, logText] = await Promise.all([
      problemEntry === undefined ? undefined : this.blobs.read(problemEntry.sha),
      files.log === undefined ? undefined : this.blobs.read(files.log.sha),
    ]);

    const shown: ArtifactFile[] = [];
    const hidden = new Map<string, number>();
    for (const e of files.artifacts) {
      const rel = this.rel(id, e.path);
      const by = hiddenBy(rel);
      if (by !== undefined) {
        hidden.set(by, (hidden.get(by) ?? 0) + 1);
        continue;
      }
      const t = this.times.get(e.path);
      shown.push({ path: rel, sha: e.sha, size: e.size, added: t?.added ?? 0, changed: t?.changed ?? 0, commit: t?.commit ?? '' });
    }
    return {
      id,
      ...json,
      problem:
        problemEntry === undefined || problemText === undefined
          ? null
          : { path: problemEntry.path, sha: problemEntry.sha, text: problemText.toString('utf8'), changed: this.times.get(problemEntry.path)?.changed ?? 0 },
      log:
        files.log === undefined || logText === undefined
          ? null
          : { sha: files.log.sha, entries: parseLog(logText.toString('utf8')), changed: this.times.get(files.log.path)?.changed ?? 0 },
      files: shown,
      hidden: [...hidden].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    };
  }

  public close(): Promise<void> {
    return this.blobs.close();
  }

  /** The path inside the task's `artifacts/`. */
  private rel(id: string, path: string): string {
    return path.slice(`tasks/${id}/artifacts/`.length);
  }

  private async taskJson(entry: TreeEntry): Promise<TaskJson> {
    const known = this.parsed.get(entry.sha);
    if (known !== undefined) return known;
    let raw: unknown = {};
    try {
      raw = JSON.parse((await this.blobs.read(entry.sha))?.toString('utf8') ?? '{}');
    } catch {
      raw = {};
    }
    const json = readTaskJson(raw);
    this.parsed.set(entry.sha, json);
    return json;
  }

  /**
   * What arrived in artifacts, newest first: the commits in a row on one
   * task, within PUSH_GAP_S of each other, as one push. A file deleted in
   * the push is there as deleted; one written in it and deleted since, or
   * hidden, is left out; a file written twice in one push is there once.
   */
  private pushes(): Push[] {
    const pushes: { task: string; at: number; from: number; files: Map<string, { path: string; sha: string; status: 'A' | 'M' | 'D'; at: number }> }[] = [];
    for (const c of this.commits) {
      const byTask = new Map<string, FileChange[]>();
      for (const f of c.files) {
        const [, id, dir] = f.path.split('/');
        if (dir !== 'artifacts' || id === undefined || (f.status !== 'A' && f.status !== 'M' && f.status !== 'D')) continue;
        byTask.set(id, [...(byTask.get(id) ?? []), f]);
      }
      for (const [task, changes] of byTask) {
        const last = pushes[pushes.length - 1];
        let push = last !== undefined && last.task === task && last.from - c.at <= PUSH_GAP_S ? last : undefined;
        if (push === undefined) {
          if (pushes.length >= MAX_PUSHES) return this.finish(pushes);
          pushes.push((push = { task, at: c.at, from: c.at, files: new Map() }));
        }
        push.from = c.at;
        // Newest commit first: a file's first change seen is where it ended up.
        for (const f of changes) {
          const entry = this.byPath.get(f.path);
          const rel = this.rel(task, f.path);
          if (hiddenBy(rel) !== undefined) continue;
          const had = push.files.get(rel);
          if (had === undefined) {
            if (f.status === 'D') push.files.set(rel, { path: rel, sha: '', status: 'D', at: c.at });
            else if (entry !== undefined) push.files.set(rel, { path: rel, sha: entry.sha, status: f.status as 'A' | 'M', at: c.at });
          } else if (f.status === 'A') {
            // Added within the push: new if it is still there, nothing at all if it went again.
            if (had.status === 'D') push.files.delete(rel);
            else had.status = 'A';
          }
        }
      }
    }
    return this.finish(pushes);
  }

  private finish(pushes: { task: string; at: number; files: Map<string, { path: string; sha: string; status: 'A' | 'M' | 'D'; at: number }> }[]): Push[] {
    return pushes.filter((p) => p.files.size > 0).map((p) => ({ task: p.task, at: p.at, files: [...p.files.values()] }));
  }
}
