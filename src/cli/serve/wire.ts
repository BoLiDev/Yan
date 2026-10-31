// What `yan serve` sends its page, as JSON carries it: the one definition of
// it, which serve builds its answers to and the page (web/src/lib/api.ts)
// reads them by. Types alone, with nothing to import, so the page takes them
// with `import type` and its build never sees this file.
//
// A vault is read by older and newer yans alike, so a task's state and a
// deliverable's status are whatever task.json says: the ones this yan knows
// are named apart, and the page shows any other as best it can.

/** The states this yan gives a task. */
export type KnownTaskState = 'open' | 'uat' | 'done' | 'abandoned';
/** The statuses this yan gives a deliverable. */
export type KnownDeliverableStatus = 'todo' | 'done' | 'abandoned';

/** Where serve stands with the vault: said on every tick, and after every change made from the page. */
export interface Status {
  /** Counts up each time the commit being shown moves. */
  readonly version: number;
  readonly commit: string | null;
  readonly checkedAt: number | null;
  readonly pulledAt: number | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly everyS: number;
  /** The vault has no origin, so nothing is fetched. */
  readonly local: boolean;
  /** Which yan is serving: a page loaded from another reloads itself. */
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
  /** "" when task.json cannot be read. */
  readonly title: string;
  readonly state: string;
  readonly createdAt: string | null;
  readonly closedAt: string | null;
  readonly repos: readonly RepoSummary[];
  readonly deliverables: { readonly done: number; readonly todo: number; readonly abandoned: number };
  /** Its agents running elsewhere, as on a cloud platform: its run resources that are web links, by name, the last kept first. */
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

/**
 * One file of a push. A deleted file has no sha: there is nothing left to
 * show. `at` is the newest commit of the push that touched it, so a file
 * looked at stays seen when later commits join its push.
 */
export interface PushFile {
  readonly path: string;
  readonly sha: string;
  readonly status: 'A' | 'M' | 'D';
  readonly at: number;
}

export interface Push {
  readonly task: string;
  /** The newest commit's time. */
  readonly at: number;
  readonly files: readonly PushFile[];
}

/** How a vault file opens on its forge: `{path}` in `template` to fill in. */
export interface FileLink {
  readonly forge: string | null;
  readonly template: string;
}

/** Which files of a branch are its source code: an include matches and no exclude does. */
export interface SourceRules {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** `/api/index`: every task, what arrived, and the vault. */
export interface Index {
  readonly tasks: readonly TaskSummary[];
  readonly latest: readonly Push[];
  readonly status: Status;
  readonly vault: {
    readonly name: string;
    readonly dir: string;
    readonly fileLink: FileLink | null;
    readonly source: SourceRules;
  };
  /** Where the vault's files are served, one port up. */
  readonly filesOrigin: string;
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

/** `/api/task/<id>`: one task whole. */
export interface TaskDetail {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly createdAt: string | null;
  readonly closedAt: string | null;
  readonly reason: string | null;
  readonly repos: readonly (RepoSummary & { readonly url: string; readonly bases: Readonly<Record<string, string>> })[];
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

export interface BranchCommit {
  readonly sha: string;
  readonly at: number;
  readonly author: string;
  readonly subject: string;
}

export interface BranchFile {
  readonly path: string;
  /** Where a renamed file came from. */
  readonly from: string | null;
  /** A, M, D, R, C, T. */
  readonly status: string;
  /** null for a binary file. */
  readonly add: number | null;
  readonly del: number | null;
}

/** `/api/branch`: a task's branch against origin's default branch, from this machine's clone. */
export interface BranchView {
  readonly repo: string;
  readonly url: string;
  readonly branch: string;
  readonly clone: string | null;
  /** Why there is nothing more to show; null when there is. */
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
    /** Where a commit and a file of the repository open on its forge, `{sha}`, `{ref}` and `{path}` to fill in; null for a forge yan cannot tell. */
    readonly forge: { readonly name: string; readonly commit: string; readonly blob: string } | null;
  };
  readonly commits: readonly BranchCommit[];
  readonly files: readonly BranchFile[];
}

/** `/api/branch/tree`: one file at a branch's head. */
export interface BranchBlob {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}

/** `/api/branch/commit`: a commit, its patch cut at serve's limit. */
export interface CommitPatch {
  readonly sha: string;
  readonly at: number;
  readonly author: string;
  readonly subject: string;
  readonly body: string;
  readonly patch: string;
  readonly truncated: boolean;
}

/** One file of a report's uat/, with what uat.json records of it. */
export interface UatFile {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  /** The deliverables it shows. */
  readonly for: readonly string[];
  readonly shows: string | null;
  /** Where it opens in the vault's repository, when that can be told. */
  readonly url: string | null;
}

/** `/api/report`: a task's report.html, pictures taken out, and what changed since it was written. */
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

/** What herdr says of a pane's agent: at work, waiting on `user`, finished and not looked at, or idle. */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/** How herdr has split a tab: a pane, or two side by side (`right`) or one over the other (`down`), the first taking `ratio` of the room. */
export type Layout =
  | { readonly pane: string }
  | { readonly split: 'right' | 'down'; readonly ratio: number; readonly first: Layout; readonly second: Layout };

/** `/api/terminals`, by task: an agent bare `yan` started in a herdr pane on this machine, while it runs. */
export interface TerminalState {
  readonly status: AgentStatus;
  /** The agent herdr finds in the pane, as `claude`; null once it has exited and the pane is a shell again. */
  readonly agent: string | null;
  /** The CLI bare `yan` started. */
  readonly cli: string;
  readonly pane: string;
  readonly since: string;
  /** herdr's version, and whether it streams a pane. */
  readonly herdr: string;
  readonly streams: boolean;
  /** The agent's tab, as herdr has it split: its pane alone, or it and the panes split off beside it. */
  readonly layout: Layout;
  /** A launch's: the new task's title, and the task once bare `yan` keeps the pane as its terminal. */
  readonly title?: string;
  readonly task?: string;
}

/** `/api/launch/repos`: a repository a new task may work in, with its packages when it has several. */
export interface LaunchRepo {
  readonly name: string;
  readonly packages: readonly string[];
}

export type UpdateStep = 'pull' | 'install' | 'build' | 'restart';
export type UpdateStepState = 'wait' | 'now' | 'done' | 'failed';

/** `/api/yan/update`: yan updating itself, a step at a time. */
export interface UpdateState {
  readonly running: boolean;
  readonly steps: readonly { readonly step: UpdateStep; readonly state: UpdateStepState }[];
  /** What the step that failed said last. */
  readonly error: string | null;
}

/** `/api/yan/updates`: how far yan's clone is behind what it tracks, once fetched; or why that cannot be told. */
export type Behind = { readonly behind: number } | { readonly error: string };
