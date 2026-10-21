# `yan`

Notes that outlive an agent session. We think about a task in three parts,
and it keeps a note for each: the problem (`problem.md`: the background, and
what the problem is), the solution (its deliverables: how things must be
once it is solved), and the log of the decisions that steered it. Beside
them it keeps the resources the work refers to, your own drafts, and, when
it touches a repository, a worktree of its own. `yan` keeps those and
nothing else.

An agent knows about them only when you start it through `yan`. Type `yan`,
pick a task or start one, and Claude, Codex or Agy starts in the task's
worktree, told in a few lines about those three parts and that a CLI keeps
notes on them. Start the same agent directly and it never hears of yan.

## Getting started

```sh
npm run setup                     # install, build, npm link
yan vault init personal --remote git@github.com:you/yan-vault-personal.git
```

`yan vault init` needs an empty repository on your forge first. On a second
machine, `yan vault clone <url>` instead.

Then register the repositories you work in, with `yan repo add` in a clone
or in the directory that holds them, and type `yan` anywhere.

## What there is

Bare `yan`, at a terminal, picks an open task or starts one, and runs the
agent on it in this terminal, with its approvals skipped (`"skipPermissions":
false` in the vault's `config.json` hands them back). A new task picks
the repositories it works in from the registry, and gets a worktree of each
on a detached HEAD at origin's default branch; in a monorepo it also asks
which packages the task is about, once. yan never makes a branch, since each
machine names its branches its own way: the agent is told to cut one before
it commits, and every `yan vault push` keeps the branch each open task's
tree is on, as origin names it, and the one it replaces among the task's
earlier branches. A tree opened
later for the task, on any machine, is put on the branch it keeps: the
clone's own, brought up to origin's when it is only behind it, or a new one
tracking origin's; one yan cannot put there starts detached, and says why.
Every step, the worktrees included, is a line on the one chain
the questions are on. The agent starts in the first tree, with the others
added beside it, and every start tells it which is which, and where the
task's own files are: problem.md, and artifacts/ for what the work produces,
with designs in artifacts/design/ and what you check the result by in
artifacts/uat/, gathered deliverable by deliverable: a screenshot or
recording for each one, named for it (d3-before.png, d3-after.png) and
recorded with `yan uat` as it is made, or a note of how it was checked
where nothing on screen shows it; the before shot before the change is made,
and something that did not exist before recorded as new, with no before;
and once all of it is there, marking the task 验收中 with `yan uat ready`
is the agent's to do.
An artifact redone replaces its file; the vault's history keeps the old one.
While it runs, the vault is kept in step with your other machines without
the agent being told: it is pulled each time you send a message and pushed
each time the agent finishes a turn, by hooks given to that session alone
(claude's `--settings`, codex's `-c`, with codex's hook trust bypassed for
the session). agy takes hooks only from files, so under agy the vault is
pulled and pushed by hand. A push keeps the branch each tree is on, commits
everything in the vault and rebases it onto the remote first; a conflict
stops it, the commit kept here, and the hook says so.
`--cli codex` runs another agent this once; anything after `--` goes to the
agent as it is.

For you:

- `yan ls` — every open task, one line each, those handed to you to accept as 验收中; `--status all` for the rest
- `yan peek [id]` — one task at a glance: its trees, the start of its problem, its resources and newest drafts
- `yan done [id]` — close a task and give its worktrees back; `--abandon "<why>"`
- `yan draft [id]` — your own notes about a task, in your editor
- `yan serve` — the vault in the browser on this machine, kept up to date as agents push: every task, those waiting for you to accept them apart, its notes and branch, every artifact shown as what it is, and its report to check each deliverable on
- `yan vault …` — init, clone, use, pull, push, where, ls
- `yan repo add|link|ls|rm` — the repositories a new task picks from, and where each is cloned here
- `yan debug [id]` — what yan tells an agent: the opening prompt a start of the task would give now

For the agent:

- `yan context` — a summary to start from: the task's problem in full, its deliverables and resources, its artifacts by folder, and where each branch stands (ahead of the default branch, unpushed, uncommitted); `--json` lists every artifact with its web address in the vault's repository, for a report or a recap to build on
- `yan log` — what earlier sessions settled; `yan log agreed|changed|paused "<line>"` records one
- `yan deliverable add|edit|done|abandon` — the solution, in Chinese unless you ask for another language, changed only when you agree to a different one
- `yan uat [add|note|rm]` — what you check each deliverable by: each file in artifacts/uat/ with the deliverables it shows and what it shows of them, a note for one nothing on screen can show; bare, every deliverable with its evidence and which have none
- `yan uat ready` — the task is handed to you to accept: its state becomes `uat`, shown as 验收中, and stays so through the changes your feedback asks for until `yan done`
- `yan resource add|rm|ls` — anything the work refers to, under a name, as one of: `spec` (ticket, PRD, design), `mr`, `preview` (a link to the deployed version), `run` (a sub-task elsewhere), `general`
- `yan branch [name]` — keep a branch for the task by hand; a push keeps the one each worktree is on, and the ones it replaces stay as the task's earlier branches
- `yan learn add|ls` — a learning, written only when you ask for one

`yan <command> --help` says the rest. Every command that takes a task reads
`$YAN_TASK` when none is given, which is what `yan` sets for the agent it
starts.

`yan serve` runs until stopped, at `http://localhost:4747` (`--port`). Every
10 seconds (`--every`) it fetches the vault into refs of its own,
`refs/yan/serve/`, and reads git objects rather than the work tree, so
nothing an agent or a hook works with moves; an open page follows without
being reloaded. Left running while yan is updated, it restarts on the newer
build by itself once that build is complete and starts, in the same process
and on the same port, and an open page reloads onto it. With the bell beside Latest on, Chrome shows a silent macOS
notification when a push arrives, the task's name as its title and nothing
else, and clicking it opens Latest on that push; the page has to be open for
it, in the background or minimised, and Chrome's permission is asked on the
first click. Each push's line in Latest opens to the files it brought, and
the arrow at its end opens the task's overview. Images, pages, Markdown, code, logs, audio, video and fonts
open in place, and prev and next walk a folder. A task that keeps a branch
shows it against origin's default branch, from this machine's clone: its
changed files and their diffs, its commits, and every file at its head; the
branches it was on before are listed under it, each shown the same way. A
branch's row in the task's nav ends, on hover, in a button that copies the
branch's whole name, which the row may cut short. Code
is coloured by its language, in a diff, in a file and in a Markdown fenced
block alike, by highlight.js served from yan's own copy, so the page still
fetches nothing from the network; a language outside the common set is served
from the same copy the first time a file needs it, and a file whose language
yan does not know stays plain. A
branch already merged is compared from where it left, and its merge commit
names the pull request, so it shows the same change however far the default
branch has moved since; one deleted from origin is found again from what its
merge commit says. The artifacts are served on the next port up, so a
page an agent wrote runs as its own site and cannot reach the one around it.

A task its agent marked with `yan uat ready` is listed under 验收中, above
the ones in progress, and its overview's tag says so. It stays there while
changes are made on your feedback; nothing turns it back to in progress,
and accepting it is `yan done`, as for any task.

A task's overview is where its problem and deliverables are put right while
they are still being defined. 编辑 opens problem.md whole, as Markdown, and
saving is refused when an agent changed it since the page read it. A
deliverable's text is edited where it stands; the bin that shows under its
date on hover gives it up, with a reason that stays on its line and is
edited the same way. A resource's pencil edits where it points, keeping its
kind, and its bin forgets it. While you type, or while the problem is open,
the page holds off redrawing for new commits, so nothing typed is lost.

A task with an artifacts/report.html, the page a report skill writes from
what `yan uat` recorded, has a Report beside its overview. Each deliverable
is shown there as task.json has it now: tick it done, untick it, give it
up with a reason or edit the reason it was given up for, and task.json
changes; click a text of the page and edit it, and report.html changes. Every change made on the overview or the report is committed and pushed as
`yan vault push` would; those are the only writes `yan serve` makes, and
only from its own page.
A picture clicked opens large in a modal over the page, ← and → going
through the others; recordings play in place, full screen from their own controls, with
their link to copy; every file in uat/ can be downloaded, and the page itself downloads with the deliverables in the state
they are in, less the ones given up: the copy is a report to hand to others, so
what was given up is left out with its pictures, and the counts are of the rest. When a deliverable was reworded or added, or a file of evidence recorded,
replaced or dropped since the page was written (report.json beside it says
what it was written from), its bar says legacy and what changed.

## Where things are

```
<vault>/                       a git repository, one per context (personal, work)
  vault.json                   { version: 2, name, created }
  config.json                  { cli, model, effort, skipPermissions }: the agent bare yan starts; artifactLinks: how a vault file opens on a forge yan cannot tell
  repos.json                   { version: 1, repos: { <name>: { url } } }: what yan repo registered
  learnings/<topic>.md         front matter (name, description) and the text
  tasks/<id>/
    task.json                  title, state (open, uat, done, abandoned), repos (URL, scope, branch and earlier branches each), deliverables, resources and their kinds
    problem.md                 prose: the background, and what the problem is (brief.md before)
    log.md                     - MM-DD  type  line, appended only
    drafts/<draft-id>.md       yours, in the format of the `draft` CLI
    artifacts/                 whatever the work produced worth keeping, as it stands now
      design/                  HTML pages, canvases, diagrams of a system
      uat/                     screenshots and recordings to check the result by: d3-before.png, d3-after.png, d3.webm
        uat.json               { version: 1, files: { <path>: { for, shows, side?: before|after|new } }, notes: { <d>: how } }: what yan uat recorded
~/.yan/config.json             which vaults this machine has, the active one, and where each repository is cloned
~/.yan/trees/<repo>-<hash>/    the worktree pool: <slot>/<repo>/ and leases/
```

The pool keeps its trees. Returning one resets and cleans it but keeps what
git ignores, so the next task in that slot starts with `node_modules` in
place, and takes it off any branch the agent cut, so the branch can be
checked out anywhere else. `yan done` refuses to return a tree holding
uncommitted or unpushed work; `--force` throws that work away, and never a
branch.

## Third-party material

`templates/fonts/` holds two woff2 subsets of **ChillRoundF** (寒蝉全圆体)
by ChillType, the face `yan serve` draws in, under the SIL Open Font
License 1.1. `templates/fonts/OFL.txt` is the licence and the copyright
notice, and the `README.md` beside it says what is in the subsets and how they
were cut. Everything else here is yan's own.
