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

/**
 * serve answered, and said no: its words are the message. Anything else
 * thrown by these is serve not answering at all, which the page takes as it
 * having stopped.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message || `serve answered ${status}`);
  }
}

async function answer(r: Response): Promise<Response> {
  if (!r.ok) throw new ApiError(r.status, await r.text());
  return r;
}

export async function getJSON<T>(url: string): Promise<T> {
  return (await (await answer(await fetch(url))).json()) as T;
}

export async function getText(url: string): Promise<string> {
  return (await answer(await fetch(url))).text();
}

export async function getBytes(url: string): Promise<ArrayBuffer> {
  return (await answer(await fetch(url))).arrayBuffer();
}

/** Every request of the page's that does something: a JSON body, and serve's JSON answer. */
export async function postJSON<T>(url: string, value: unknown): Promise<T> {
  const r = await answer(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }));
  return (await r.json()) as T;
}

export const looksBinary = (text: string): boolean => text.slice(0, 8000).includes('\u0000');

