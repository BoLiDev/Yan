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
it commits. Every step, the worktrees included, is a line on the one chain
the questions are on. The agent starts in the first tree, with the others
added beside it, and every start tells it which is which, and where the
task's own files are: problem.md, and artifacts/ for what the work produces.
While it runs, the vault is kept in step with your other machines without
the agent being told: it is pulled each time you send a message and pushed
each time the agent finishes a turn, by hooks given to that session alone
(claude's `--settings`, codex's `-c`, with codex's hook trust bypassed for
the session). agy takes hooks only from files, so under agy the vault is
pulled and pushed by hand. A push commits everything in the vault and
rebases it onto the remote first; a conflict stops it, the commit kept here,
and the hook says so.
`--cli codex` runs another agent this once; anything after `--` goes to the
agent as it is.

For you:

- `yan ls` — every open task, one line each; `--status all` for the rest
- `yan peek [id]` — one task at a glance: its trees, the start of its problem, its resources and newest drafts
- `yan done [id]` — close a task and give its worktrees back; `--abandon "<why>"`
- `yan draft [id]` — your own notes about a task, in your editor
- `yan ui` — a work report of every task, in the browser
- `yan vault …` — init, clone, use, pull, push, where, ls
- `yan repo add|link|ls|rm` — the repositories a new task picks from, and where each is cloned here

For the agent:

- `yan context` — the task's problem in full, its deliverables and its resources, read before working
- `yan log` — what earlier sessions settled; `yan log agreed|changed|paused "<line>"` records one
- `yan deliverable add|edit|done|abandon` — the solution, changed only when you agree to a different one
- `yan resource add|rm|ls` — tickets, docs, releases, paths: anything the work refers to, under a name
- `yan learn add|ls` — a learning, written only when you ask for one

`yan <command> --help` says the rest. Every command that takes a task reads
`$YAN_TASK` when none is given, which is what `yan` sets for the agent it
starts.

## Where things are

```
<vault>/                       a git repository, one per context (personal, work)
  vault.json                   { version: 2, name, created }
  config.json                  { cli, model, effort, skipPermissions }: the agent bare yan starts
  repos.json                   { version: 1, repos: { <name>: { url } } }: what yan repo registered
  learnings/<topic>.md         front matter (name, description) and the text
  tasks/<id>/
    task.json                  title, state, repos (URL and scope each), deliverables, resources
    problem.md                 prose: the background, and what the problem is (brief.md before)
    log.md                     - MM-DD  type  line, appended only
    drafts/<draft-id>.md       yours, in the format of the `draft` CLI
    artifacts/                 whatever the work produced worth keeping
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

`templates/ui/fonts/` holds two woff2 subsets of **ChillRoundF** (寒蝉全圆体)
by ChillType, the face `yan ui` draws its report in, under the SIL Open Font
License 1.1. `templates/ui/fonts/OFL.txt` is the licence and the copyright
notice, and the `README.md` beside it says what is in the subsets and how they
were cut. Everything else here is yan's own.
