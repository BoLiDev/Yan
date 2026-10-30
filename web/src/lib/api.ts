// What yan serve answers, and how the page asks it. The shapes are the
// server's (src/cli/serve/), as JSON carries them.

export type TaskState = 'open' | 'uat' | 'done' | 'abandoned';
export type DeliverableStatus = 'todo' | 'done' | 'abandoned';

export interface Status {
  readonly version: number;
  readonly commit: string | null;
  readonly checkedAt: number | null;
  readonly pulledAt: number | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly everyS: number;
  readonly local: boolean;
  readonly build: string;
}

export interface RepoSummary {
  readonly name: string;
  readonly branch: string | null;
  readonly earlier: readonly string[];
  readonly abandoned: readonly string[];
}

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly state: TaskState;
  readonly createdAt: string | null;
  readonly closedAt: string | null;
  readonly repos: readonly RepoSummary[];
  readonly deliverables: { readonly done: number; readonly todo: number; readonly abandoned: number };
  /** Its agents running elsewhere, as on a cloud platform: its run resources that are web links, by name. */
  readonly agents: readonly (readonly [string, string])[];
  readonly artifacts: number;
  readonly added: readonly number[];
  readonly touched: number;
  /** The task's files hashed: it changes when, and only when, something of the task's does. */
  readonly rev: string;
}

export interface PushFile {
  readonly path: string;
  readonly sha: string;
  readonly status: 'A' | 'M' | 'D';
  readonly at: number;
}

export interface Push {
  readonly task: string;
  readonly at: number;
  readonly files: readonly PushFile[];
}

export interface FileLink {
  readonly forge: string | null;
  readonly template: string;
}

export interface Index {
  readonly tasks: readonly TaskSummary[];
  readonly latest: readonly Push[];
  readonly status: Status;
  readonly vault: { readonly name: string; readonly dir: string; readonly fileLink: FileLink | null };
  readonly filesOrigin: string;
}

export interface ArtifactFile {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly added: number;
  readonly changed: number;
  readonly commit: string;
}

export interface Deliverable {
  readonly id: string;
  readonly text: string;
  readonly status: DeliverableStatus;
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
  readonly state: TaskState;
  readonly createdAt: string | null;
  readonly closedAt: string | null;
  readonly reason: string | null;
  readonly repos: readonly (RepoSummary & { readonly url: string })[];
  readonly deliverables: readonly Deliverable[];
  readonly resources: readonly (readonly [string, string])[];
  readonly problem: { readonly path: string; readonly sha: string; readonly text: string; readonly changed: number } | null;
  readonly log: { readonly sha: string; readonly entries: readonly LogEntry[]; readonly changed: number } | null;
  readonly files: readonly ArtifactFile[];
  readonly hidden: readonly { readonly name: string; readonly count: number }[];
}

export interface BranchFile {
  readonly path: string;
  readonly from: string | null;
  readonly status: string;
  readonly add: number | null;
  readonly del: number | null;
}

export interface BranchCommit {
  readonly sha: string;
  readonly at: number;
  readonly author: string;
  readonly subject: string;
}

export interface BranchView {
  readonly repo: string;
  readonly url: string;
  readonly branch: string;
  readonly clone: string | null;
  readonly missing: string | null;
  readonly fetchedAt: number | null;
  readonly fetchError: string | null;
  readonly target: string;
  readonly base: string;
  readonly head: string;
  readonly merged: { readonly sha: string; readonly at: number; readonly pr: number | null } | null;
  readonly ahead: number;
  readonly behind: number;
  readonly links: {
    readonly pr: string | null;
    readonly compare: string | null;
    readonly branch: string | null;
    readonly forge: { readonly name: string; readonly commit: string; readonly blob: string } | null;
  };
  readonly commits: readonly BranchCommit[];
  readonly files: readonly BranchFile[];
}

export interface BranchBlob {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}

export interface CommitPatch {
  readonly sha: string;
  readonly at: number;
  readonly author: string;
  readonly subject: string;
  readonly body: string;
  readonly patch: string;
  readonly truncated: boolean;
}

export interface UatFile {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly for: readonly string[];
  readonly shows: string | null;
  readonly url: string | null;
}

export interface Report {
  readonly html: string;
  readonly sha: string;
  readonly generatedAt: string | null;
  readonly behind: readonly string[];
  readonly uat: readonly UatFile[];
}

/** What a change made from the page answers: committed here, and pushed unless `warning` says why not. */
export interface WriteResult {
  readonly ok: boolean;
  readonly warning: string | null;
  readonly status: Status;
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return (await r.json()) as T;
}

export async function getText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.text();
}

export async function postJSON<T>(url: string, value: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const text = await r.text();
  if (!r.ok) throw new Error(text || `${r.status}`);
  return JSON.parse(text) as T;
}

export const looksBinary = (text: string): boolean => text.slice(0, 8000).includes('\u0000');

