# Yan v1, part by part

Research for [#105](https://github.com/BoLiDev/Yan/issues/105), on the map [#101](https://github.com/BoLiDev/Yan/issues/101).
An inventory of what Yan v1 is at commit `63941f3` (2026-11-25, 769 commits since 2026-08-05): every part, what it is for, what it depends on, and how many lines of source and of tests it accounts for. It gives no verdict on what to keep.

## How this was measured

- Source of truth: the tree at `63941f3`. Claims cite the file that owns them. `README.md` is cited for behaviour, the code for structure and formats.
- The old `AGENTS.md` (`git show ea566f0:AGENTS.md`) is cited for the Layout and "Rules of the design" sections, which the current `AGENTS.md` no longer has.
- Lines are `wc -l` over `git ls-files`, blank lines and comments included. A file counts as a test when its path matches `.test.`, `tests/` or `testing/`. Binary files and `package-lock.json` are left out.
- `dist/` was not built, so `yan --help` was not run. Command descriptions are read from each `src/cli/<name>.ts`.
- Lines are long in this codebase (README lines aside, source averages 50 to 55 bytes a line, with many comment paragraphs), so line counts understate reading effort a little but compare fairly between parts.

## The whole in numbers

| Area | Source files | Source lines | Test files | Test lines |
|---|---:|---:|---:|---:|
| `src/` (CLI, records, externals, serve's server) | 111 | 15,576 | 29 | 3,186 |
| `web/` (the page) | 168 | 14,484 | 43 | 2,853 |
| `tests/` (integration, e2e, helpers) | 0 | 0 | 37 | 6,327 |
| `plugin/` (skills and the report renderer) | 11 | 786 | 0 | 0 |
| `.claude/skills/monkey/` | 6 | 974 | 0 | 0 |
| `templates/`, `scripts/`, `bin/`, root files | 22 | 2,255 | 0 | 0 |
| **Total** | **318** | **34,075** | **109** | **12,366** |

Root files include `README.md` at 863 lines, which is the only description of behaviour: the project rule was "No design documents" (old `AGENTS.md`, Rules of the design).

Two halves stand out:

- **The page** (`yan serve`'s server plus `web/`): 19,362 source lines, about 64% of the 30,060 lines under `src/` and `web/`; and 6,831 test lines, about 55% of all tests.
- **Everything else** (commands, launcher, records, pool, sync, util): 10,698 source lines and 5,535 test lines.

## Inventory

Each part: what it is for, what it leans on, and its size as source / tests.

### 1. The vault and its sync through git

A vault is a git repository, one per context (personal, work), holding `vault.json`, `config.json`, `repos.json`, `learnings/`, `drafts/` and `tasks/<id>/` (`README.md`, "Where things are"). It is shared across machines by git alone.

- **Pull and push** (`src/cli/shared/vault-pull.ts` 121, `vault-push.ts` 202): a push commits everything, rebases onto the remote, pushes; a conflict stops it with the commit kept. Neither touches a vault in the middle of a rebase or merge, and no command writes to one then (`refuseWhileUnfinished`, `src/util/vault.ts`).
- **Hooks**: the agent is not told about sync. The launcher gives the session a hook that pulls on each user message and pushes on each finished turn (claude `--settings`, codex `-c`; agy has none) (`src/externals/harness/launch.ts`).
- **Commands that push as they finish**: `done`, `pause`, `resume`, `repo add|rm`, `draft` (`shareChange`, `vault-push.ts`).
- **Each push also notes** where each kept branch last met the default branch (`branchBases` in task.json), to tell a fast-forwarded branch from a new one.
- **Compatibility rule**: machines update yan at different times, so file changes add optional fields and keep old names readable; task.json is written through `Task.edit`, which keeps unknown fields (old `AGENTS.md`).
- **Several vaults**: `~/.yan/config.json` lists them in order. The first is the active one (new tasks, drafts, learnings, `config.json`). Tasks of all are shown as one list, and a shared id belongs to the earlier vault. Below a command everything works on one vault, the one `vaultDir()` names; serve wraps each vault's work in `inVault` (`src/util/vault.ts`, `src/cli/serve/front.ts`).
- **Local vaults**: `type: local` in the machine config. Nothing is fetched or pushed, a push only commits, serve watches the files and commits shortly after writing pauses, and the agent is told never to pull, push or add a remote (`localLines`, `src/cli/shared/launch.ts`).

Size: `src/cli/vault.ts` 385, `vault-pull.ts` + `vault-push.ts` 323, `src/util/vault.ts` 303, `src/util/git.ts` 246, `src/util/lock.ts` 145, `src/util/machine.ts` 332 = about 1,730 source. Tests: `tests/integration/vault.test.ts` 572 plus unit tests for git, lock, machine and vault 320 = about 890.

### 2. What a task holds

`tasks/<id>/` in the vault (`src/records/task/types.ts`, `README.md`):

| File | What it is | Who writes it |
|---|---|---|
| `task.json` (version 2) | `title`, `state` (`open`, `uat`, `done`, `abandoned`), `createdAt`, `closedAt`, `pausedAt` (paused is a field, not a state), `reason`, `repos[]`, `nextDeliverable`, `deliverables[]`, `resources` and `resourceKinds` | commands only |
| `task.json` `repos[]` | per repository: `url`, `scope` (packages in a monorepo), `branch` (kept last), `earlierBranches`, `branchMarks` (`open` or `abandoned`), `branchBases` | `yan branch`, each push |
| `task.json` `deliverables[]` | `id` (`d1`… by place, no gaps), `text`, `status` (`todo`, `done` with `doneAt`, `abandoned` with `reason`) | `yan deliverable`, the page |
| `task.json` `resources` | name to value, each of a kind: `spec`, `mr`, `preview`, `run`, `general` | `yan resource`, the page |
| `problem.md` | prose: the background and what the problem is (`brief.md` in older tasks, still read) | the agent directly, or the page |
| `principles.md` | the user's standing requirements for the task; absent in most tasks | only through `yan:principle` |
| `log.md` | `- MM-DD  type  line`, appended only; types `scope`, `progress`, `paused` (older `agreed`, `changed`, `started`, `delivered`, `incident` are read, not written) | `yan log` |
| `reviews/<when>.md` | one review written on the page, named for its UTC moment, never edited | the page |
| `drafts/<id>.md` | drafts from when they were per task; still read and written in place | the user |
| `artifacts/report.html`, `report.json` | the UAT report and what it was built from; the only loose files | `yan:uat`'s renderer, edits from the page |
| `artifacts/output/` | what the task itself delivers when that is not code in a repository | the agent |
| `artifacts/design/` | what the user will see: pages, mockups, palettes | the agent |
| `artifacts/docs/` | written documents about the work: technical design, research, handoff | the agent |
| `artifacts/uat/` and `uat.json` | screenshots and recordings, and `{ files: { path: { for, shows, side } }, notes: { d: how } }` | the agent, `yan uat` |
| `artifacts/misc/` | scripts, queries, data pulled for a check | the agent |

Outside the task folder, the vault also holds:

- **Drafts** (`drafts/<stamp>[-slug].md`, pictures in `drafts/<id>/`): the user's own notes, shared by every task. Agents read them (the ten newest are listed by `yan context`) and never write one.
- **Learnings** (`learnings/<topic>.md`, front matter `name` and `description`): written only when the user asks, through `yan learn add`.
- **Repositories** (`repos.json`: name to URL). Where each is cloned is this machine's, in `~/.yan/config.json` `clones`.
- **Janus's task** (`tasks/janus/`): a task folder that is never listed, numbered, paused or closed.

Design rule behind this: every piece of information has one writer. Structured state belongs to a command, prose to a file the agent edits, and the append-only log goes through `yan log` (old `AGENTS.md`).

Size of `src/records/`: task 1,241 / 465 (`task.ts` 745, `uat.ts` 310, `types.ts` 173), drafts 350 / 211, reviews 120 / 69, log 98 / 64, learnings 129 / 0, repos 118 / 0. Total 2,056 / 809.

### 3. Commands

Each `src/cli/<name>.ts` exports a `command`, found from `dist/cli/` at run time (`src/cli/yan.ts`). Every command that takes a task reads `$YAN_TASK` when none is given. 21 files, 3,141 lines.

For the user:

| Command | What it does | Lines |
|---|---|---:|
| bare `yan` | picks or starts a task and runs an agent on it; flags `--task`, `--new`, `--repo`, `--no-repo`, `--vault`, `--cli`, `--done`, `--abandon`, `--pause`, `--review`, `--janus`, `--trees` | `yan.ts` 256 + launcher (part 4) |
| `yan ls` | every open task of every vault, one line each; `--status all`, `--json` | 133 |
| `yan peek [id]` | one task at a glance: trees, start of the problem, resources, newest drafts | 192 |
| `yan done [id]` | close a task and return its worktrees; `--abandon`, `--force` | 82 |
| `yan pause [id]` / `yan resume [id]` | put an open task aside with its trees returned, and take it up again | 51 / 25 |
| `yan draft` | write a draft in the editor; `ls`, `cat`, `search`, `dir` | 305 |
| `yan serve` | the page (part 7) | 209 + `serve/` |
| `yan vault init\|clone\|use\|local\|pull\|push\|where\|ls` | vaults on this machine (part 1) | 385 |
| `yan pack [id]` | one task as a zip or one Markdown document for an agent with no vault; `--brief`, `--doc`, `--artifact`, `--no-artifacts`, `--drafts`, `--out` | 314 |
| `yan repo add\|link\|ls\|rm` | the registry a new task picks repositories from | 238 |
| `yan debug [id]` | the opening prompt a start of the task would give now | 31 |

For the agent:

| Command | What it does | Lines |
|---|---|---:|
| `yan context` | the summary to start from: principles, problem in full, deliverables, resources, artifacts by folder, where each branch stands, ten newest drafts; `--json` | 163 |
| `yan log [scope\|progress\|paused "<line>"]` | read or append the log | 58 |
| `yan deliverable add\|edit\|done\|abandon\|rm\|move` | the solution; `rm` and `move` renumber, and `uat.json` and file names follow | 147 |
| `yan uat [add\|note\|rm\|ready\|ls]` | evidence for each deliverable; `ready` sets state `uat` (in review) | 120 |
| `yan resource add\|rm\|ls` | named references by kind | 85 |
| `yan branch [name]`, `yan branch abandon <name>` | keep a branch as the task's, or mark one given up | 146 |
| `yan learn add\|ls` | a learning, only when the user asks | 40 |
| `yan review [name]` | print the user's newest review; `--list` | 50 |
| `yan handoff "<title>" --problem <file>` | Janus makes a task from a matter and starts its agent in a herdr tab | 111 |

Helpers in `src/cli/shared/` (22 files, 2,581 / 357) serve these: `launch.ts` 863 (part 4), vault pull and push, `task-id.ts` 121 (finds a task's vault), `artifacts.ts` 144, `deliverables.ts` 134, `progress.ts` 128, `branches.ts` 102 and `merged.ts` 79 (whether a branch is merged, read from git), `packages.ts` 93 (monorepo packages), `style.ts` 111, `wrap.ts` 94.

Tests through `bin/yan` in `tests/integration/`: `commands.test.ts` 341 (log, deliverable, resource, learn, ls, peek, context, debug, uat), `draft.test.ts` 205, `done.test.ts` 185, `pack.test.ts` 128, `repo.test.ts` 118, `branch.test.ts` 80, `memory.test.ts` 76 (a later session finds what an earlier one settled).

### 4. The launcher (bare `yan`)

What turns a task into a running agent session (`src/cli/shared/launch.ts`, `src/externals/harness/`, `src/ui/`).

- **Picks or starts a task** on a chain of questions (`src/ui/prompts.ts` 222, `src/ui/chain.ts` 62, on `@clack/prompts`). A new task is numbered after the tasks origin has in every vault, and pushed before the agent starts.
- **Opens worktrees**, one per repository, from the pool (part 5), on the branch the task kept last or detached at origin's default branch.
- **Starts one of three CLIs**: claude, codex, agy (`HARNESS_KINDS`). Model, effort and `skipPermissions` come from the vault's `config.json`. Claude always gets `--chrome`.
- **Tells the agent about yan, in two ways.** Claude is given the plugin (`--plugin-dir plugin/`, plus this machine's `skillDir` folders) and a short system prompt, `skillsPrompt`: the task is yan's, where its files go, which skills exist, when `yan:uat` is due. Codex and agy take no plugin, so `OPENING_PROMPT` tells them everything the skills say, kept in step with the skills by hand. Principles are put in the prompt in full either way.
- **Resumes claude's conversation**: a task gone on with resumes the newest session claude kept for the task's first tree since the tree became the task's, found by reading claude's own session folder (`src/externals/harness/sessions.ts`).
- **Sets `$YAN_TASK`** and the pull and push hooks for that session.
- **Asks on the user's behalf**: `--done`, `--abandon`, `--pause`, `--review` start the agent with the matching skill as the first message (`closingRequest`, `pausingRequest`, `reviewRequest`).
- **Records the pane**: an agent started inside a herdr pane is written to `~/.yan/config.json` `terminals`, so serve can show it.

Size: `launch.ts` 863, harness 255 / 77, ui 284, `yan.ts` 256, `yan-tab.ts` 71 = about 1,730 source. Tests: `tests/integration/launch.test.ts` 711 (33 cases), the largest test file after serve's.

### 5. The worktree pool

`~/.yan/trees/<repo>-<hash>/<slot>/<repo>/` with `leases/` (`src/externals/worktree/`).

- A slot is never deleted and is reused warm: returning a tree resets and cleans it but keeps what git ignores, so `node_modules` and build caches stay. The pool grows by one when every slot is leased.
- A lease names its holder (the task). `get` serialises on a per-clone lock.
- Returning refuses a tree with uncommitted or unpushed work unless `--force`; it takes the tree off any branch so the branch can be checked out elsewhere.
- yan never creates a branch. The agent cuts one and keeps it with `yan branch`; one branch is in progress per app or package the task changes.

Related, outside the pool module: the repo registry (`src/records/repos/`, `src/cli/repo.ts`), branch bookkeeping (`src/cli/branch.ts`, `src/cli/shared/branches.ts`, `merged.ts`).

Size: `src/externals/worktree/` 566 / 293.

### 6. Janus and handoff

An agent for what is not a task yet (`src/cli/shared/janus.ts` 64, `src/cli/handoff.ts` 111, `plugin/skills/handoff/`).

- `yan --janus` starts it where typed, in no worktree. It is stored as the task `janus` in the first vault, so it has a folder, log, artifacts and terminal.
- Its prompt is its own: it may read every task, every draft and every registered clone, and never changes code or writes in another task's folder.
- `yan handoff` makes a real task with the handoff file as `problem.md`, copies named artifacts, saves the vault, and starts the task's agent waiting in a herdr tab.

Tests: `tests/integration/janus.test.ts` 111, `tests/e2e/janus.test.ts` 77.

### 7. `yan serve`: the server

`src/cli/serve.ts` 209 and `src/cli/serve/` (24 files, 4,669 / 876). One process serves every vault on port 4747, and the vault's files on 4748 so a page an agent wrote runs as its own origin.

| Piece | What it does | Lines |
|---|---|---:|
| `server.ts` | routes, events, every write the page makes (deliverables, problem, resources, title, report, artifacts, reviews, drafts), each committed and pushed | 1,425 |
| `vault-view.ts`, `blobs.ts`, `history.ts` | reads the vault from git objects at a fetched ref (`refs/yan/serve/`), never the work tree; per-file history | 430 + 116 + 45 |
| `wire.ts` | the types of everything sent to the page, imported by the page as types | 420 |
| `terminal.ts`, `worktrees.ts`, `agent-watch.ts`, `launch.ts`, `closing.ts` | herdr panes streamed to the page, input typed into them, tabs for worktrees, starting a task or asking an agent to close, pause or review | 363 + 119 + 36 + 127 + 109 |
| `branch-view.ts`, `tree-snapshot.ts`, `source.ts` | a task's branch against the default branch from this machine's clone: files, diffs, commits, the uncommitted worktree as a commit on no branch | 332 + 45 + 36 |
| `report.ts` | serving and editing `report.html`, the downloadable copy, the "legacy" check | 223 |
| `front.ts` | many vaults behind one port | 236 |
| `drafts.ts`, `later-push.ts`, `save-worker.ts` | drafts written to disk at once and pushed later | 113 + 70 + 27 |
| `review-frame.ts` | the script added to an agent's page so it can be commented on | 108 |
| `update.ts`, `build.ts` | updating yan's own clone from the page and restarting on the new build | 90 + 49 |
| `thumbs.ts`, `artifact-files.ts`, `no-agent.ts` | thumbnails with sharp, renaming and deleting artifacts | 53 + 55 + 42 |

It depends on **herdr** (`src/externals/herdr/`, 284 / 149), a terminal multiplexer, for everything about terminals: the pane stream (`herdr terminal session control`, herdr 0.7.2 or later), agent status, tabs and splits. Without herdr there is no Terminal on the page, and no starting, continuing, closing or pausing a task from it.

Tests: unit tests beside the code 876; `tests/integration/serve.test.ts` 1,210 (57 cases) and `serve-vaults.test.ts` 154; `tests/helpers/fake-herdr.ts` 298.

### 8. The page

`web/src/`, React 19, TypeScript, Vite, Tailwind, TanStack Query for server data, zustand for the page's own state (old `AGENTS.md`, Layout). 165 source files, 14,381 lines; 43 test files, 2,853 lines; plus `tests/e2e/` against a real serve, 19 files, 1,738 lines.

| Area | What is in it | Source / tests |
|---|---|---:|
| `views/` | a task's pages (below) | 4,144 / 711 |
| `panes/` | the three columns: task list (`Left`), the folded rail and its bubbles (`Rail`, `RailBubble`), the task's nav and artifact tree (`Middle`, `Tree`), the page shown (`Right`) | 1,181 / 383 |
| `components/` | dialogs and menus: new task, Ctrl+F palette, settings, task menu, artifact menu, update card, font picker | 1,228 / 588 |
| `components/drafts/` | the drafts box: list, in-place writing, saving, conflict handling, pasted pictures | 640 / 119 |
| `components/review/` | comments on selections, marks, the review panel, sending to the agent | 702 / 147 |
| `components/ui/` | shadcn components on Base UI | 2,106 / 0 |
| `components/page/` | shared parts of the page | 428 / 45 |
| `lib/` | Markdown rendering and block diff, patch parsing, highlight.js, mermaid, routes, find with pinyin, "seen" marks, keys | 2,168 / 689 |
| `state/` | server data, UI state, notifications, toasts and bubbles, the review in progress, theme, fonts | 1,184 / 83 |
| `App.tsx`, `main.tsx`, `index.css` | shell and theme tokens | 600 / 0 |

The views, as a person meets them (`README.md`, `web/src/views/`):

- **Task list**: In review, in progress, Paused, Done by month; push counts and dots for what is new; a right-click menu (Rename, Pause, Done, Abandon, Resume); folds to a rail of squares.
- **Overview**: the problem (edited as Markdown) and the deliverables (edited in place, given up, deleted).
- **Principles**: read only.
- **Report**: `report.html` with each deliverable ticked, unticked or given up, texts edited in place, pictures in a modal, a downloadable copy (`Report.tsx`, `reportIsland.ts` 341, `reportEdit.ts`, `reportReview.ts`).
- **Log**: the entries, read only.
- **Terminal**: the agent's herdr tab drawn with xterm, typed into, split, with a tab per worktree (`views/terminal/`, 815 / 161).
- **Agent**: `run` resources that are web links, opened in one held browser tab.
- **MR**: every branch the task kept, and a branch's changed files, diffs, commits and files at its head (`views/branch/`, `Mr.tsx`).
- **Resources**: by kind, edited and removed.
- **Artifacts**: the folder tree; every file shown as what it is (image, page, Markdown, code, log, audio, video, font); Markdown has Rendered, Source (an editor) and History (a rendered diff of each change) (`views/file/`, 952 / 240; `lib/markdownDiff.ts` 291).
- **Drafts box**, **new task box**, **Ctrl+F palette**, **settings** (theme, fonts, which pages show, notifications, marks, vaults, updates), **Janus's page**.
- **Review**: comment on a selection anywhere (Markdown, diff, report, problem, deliverable, log, an agent's page by CSS selector), gather them, Finish writes `reviews/<when>.md`, Send to agent also types `/yan:review` into the agent.

### 9. The skills in `plugin/`

Nine skills, 357 lines of `SKILL.md`, plus the report renderer. Claude loads them with `--plugin-dir`; codex and agy are told the same in `OPENING_PROMPT`.

| Skill | Who starts it | What it tells the agent | Lines |
|---|---|---|---:|
| `yan:recap` | the agent, at the start of every session | Read `yan context`, `yan log`, `yan uat`. Say nothing unless the notes are out of date; when asked where the task stands, answer in five parts (problem, solution, done, not done, waiting on the user). Then the standing rules: rewrite a note when it changes; what the log is and is not; which artifact folder takes what; keep resources by kind; cut and keep branches, one in progress per app; read drafts, never write them; use `yan:uat` once built. The code wins over the notes. | 58 |
| `yan:define` | the agent or the user | Work out the problem, then the solution, with the user before any code. Find the cause before explaining it; explain behaviour, not identifiers; one question at a time; two checkpoints. Record in English: `problem.md`, `yan deliverable add`, `yan log scope`, `yan resource add`. | 51 |
| `yan:uat` | the agent, once an implementation can be verified | Decide what shows each deliverable; shoot the before from the merge base in a scratch worktree and the after from the task's tree with Playwright; record with captions in the page; cut a white start; name and record each file with `yan uat add` or `note`; keep one preview link; write `content.json` and run `scripts/render.mjs` to build `report.html`; run `yan uat ready`. Leave deliverable states to the user. | 137 |
| `yan:review` | the agent or the user | Read `yan review`, act on every comment, answer each by number. Never edit a review. | 16 |
| `yan:done` | the user only | Run `yan done` (or `--abandon`). Leave deliverables alone. If a tree holds unsaved work that looks like the task's, list it and stop; otherwise `--force`. | 14 |
| `yan:pause` | the user only | Commit and push work in progress on the task's branch, write `yan log paused`, run `yan pause`. | 16 |
| `yan:pack` | the user only | Agree what the other agent takes up, what it must know, and the form; push the code; write a brief outside the vault; run `yan pack`; say where the file is; note the handover in the log. Never upload it. | 27 |
| `yan:principle` | the user only | Write what the user said into `principles.md`, replacing or removing as needed; show the list; hold to it at once. | 19 |
| `yan:handoff` | Janus | Agree the scope, write the handoff as a `problem.md` for a reader with no context, run `yan handoff`, say what was made, let go. | 19 |

`plugin/skills/uat/scripts/render.mjs` (424 lines) builds `report.html` and `report.json` from `content.json` and `yan context --json`. No test names it.

### 10. Tooling around the code

- **Tests**: vitest; unit tests beside the code, `tests/integration/` through `bin/yan` against `dist/` (12 files, 3,891), `tests/e2e/` with Playwright's Chromium (19 files, 1,738), component tests in Chromium with serve stood in for (`*.test.tsx`), `tests/helpers/` 698 including a fake herdr.
- **`/monkey`** (`.claude/skills/monkey/`, 974 lines): a Claude Code skill that sends subagents to misuse yan in sandboxes (two machines sharing a vault, a fake claude, the page in Chromium) and reports what broke.
- **Module boundaries** (`scripts/check-module-boundaries.mjs`, 154): outside `src/records/<m>/` and `src/externals/<m>/`, only a module's `index.ts` is imported, and one external never imports another; checked on every build.
- **Lint**: oxlint on the page, including a 300-line limit per page file.
- **`templates/`**: the vault skeleton and the page's fonts (ChillRoundF subsets and 0xProto, both OFL).
- **Runtime dependencies**: `commander`, `@clack/prompts`, `sharp`. Outside programs: git (required), herdr (for terminals), claude, codex or agy.

## How the parts depend on each other

```
bare yan (launcher) ──> records (task, repos, drafts) ──> util (vault, git, lock, machine)
      │  ├──> worktree pool ──> git
      │  ├──> harness (claude | codex | agy) + plugin/ skills + hooks ──> vault pull / push
      │  └──> herdr (records the pane in ~/.yan/config.json)
agent in the session ──> yan context | log | deliverable | uat | resource | branch | review ──> records
yan serve ──> git objects of the vault (read) ──> page
      ├──> records + vault push (every write the page makes)
      ├──> herdr (terminal stream, agent status, tabs) ──> bare yan typed into a tab
      └──> this machine's clones (branch views)
page review ──> reviews/<when>.md ──> yan review ──> yan:review
yan:uat ──> artifacts/uat + uat.json ──> render.mjs ──> report.html ──> page's Report
Janus ──> yan handoff ──> a new task + bare yan in a herdr tab
```

- Layering (old `AGENTS.md`): `src/util/` is below everything; `src/records/` owns the vault's files; `src/externals/` wraps outside things; only `src/cli/` imports `src/ui/`.
- The page never starts an agent or closes a task itself. It types `yan …` or a skill's name into a herdr tab, so the launcher and the skills stay the one way those things happen (`src/cli/serve/launch.ts`, `closing.ts`).
- What an agent is told lives in four places: skills, claude's short prompt, `OPENING_PROMPT` for the CLIs without plugins, and each command's `--help` (old `AGENTS.md`).

## Things a reader might not expect

- **Learnings are written but not read back to an agent.** `yan learn add|ls` and `yan pack` are the only code under `src/cli/` and `src/externals/` that touch `learnings/`. `yan context`, the opening prompts and `yan:recap` do not list them. The records module has no tests.
- **Reviews, History, the Terminal, Janus's page, the drafts box and the report exist only through the page.** A review can be read with `yan review`, but only the page writes one.
- **The page is most of v1**: about 64% of source and 55% of tests, as counted above.
- **herdr is a hard dependency of the page's agent features**, and an optional one of the CLI (only `yan handoff` starting a tab).
- **Session resume reads claude's private layout** (`~/.claude/projects/<path with dashes>/<id>.jsonl`), as `src/externals/harness/sessions.ts` says in its own comment.
- **The skills and `OPENING_PROMPT` say the same things twice** and are kept in step by hand. `plugin/.claude-plugin/plugin.json` describes five of the nine skills.
- **The report renderer has no test** (`plugin/skills/uat/scripts/render.mjs`, 424 lines).
- **`AGENTS.md` points at files that are not in the tree**: `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `GLOSSARY.md`, `docs/adr/`. There was no `docs/` directory at `63941f3`; this file is the first thing under it.
- **Backward-compatible reads are spread through the records**: `brief.md`, per-task drafts, old log types, `earlierBranches`, branches without marks, `refs` on done deliverables, the old machine config shape.

## Sources

- `README.md` at `63941f3`: behaviour of every command, the page, and "Where things are".
- `git show ea566f0:AGENTS.md`: Layout and Rules of the design.
- `src/records/*/`, `src/util/machine.ts`, `src/util/vault.ts`: file formats.
- `src/cli/*.ts`: command names, options and one-line descriptions.
- `src/cli/shared/launch.ts`, `src/externals/harness/`, `src/externals/worktree/`, `src/externals/herdr/`: launcher, CLIs, pool, herdr.
- `src/cli/serve/`, `web/src/`: the server and the page.
- `plugin/skills/*/SKILL.md`: what each skill says.
- Line counts: `wc -l` over `git ls-files` at `63941f3`.
