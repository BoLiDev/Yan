// What yan serve answers, and how the page asks it. The shapes are the
// server's own, from src/cli/serve/wire.ts: types alone, which the build
// leaves behind.

import type { KnownDeliverableStatus, KnownTaskState } from '../../../src/cli/serve/wire';

export type {
  AgentStatus, ArtifactFile, BranchBlob, BranchCommit, BranchFile, BranchView, CommitPatch, Deliverable, FileLink, Index,
  LaunchRepo, Layout, LogEntry, Push, PushFile, RepoSummary, Report, Status, TaskDetail, TaskSummary, TerminalState, UatFile,
  UpdateState, Behind, WriteResult,
} from '../../../src/cli/serve/wire';

export type TaskState = KnownTaskState;
export type DeliverableStatus = KnownDeliverableStatus;

const TASK_STATES: readonly string[] = ['open', 'uat', 'done', 'abandoned'] satisfies readonly TaskState[];

/**
 * A task's state as the page treats it. A newer yan may write one this page
 * does not know, which is taken as open: the task stays in view, among those
 * in progress, rather than in none of the lists.
 */
export const stateOf = (state: string): TaskState => (TASK_STATES.includes(state) ? (state as TaskState) : 'open');

/** A deliverable's status as the page treats it; one this page does not know is still to do. */
export const statusOf = (status: string): DeliverableStatus => (status === 'done' || status === 'abandoned' ? status : 'todo');

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

