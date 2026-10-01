# `yan`

Notes that outlive an agent session. A task has a brief, a log of what was
decided, the deliverables it is measured against, your own drafts, and,
when it touches a repository, a worktree of its own. `yan` keeps those and
nothing else.

An agent knows about them only when you start it through `yan`. Type `yan`,
pick a task or start one, and Claude, Codex or Agy starts in the task's
worktree, told in two lines that a CLI keeps notes on this work. Start the
same agent directly and it never hears of yan.

Status: **v4**, the memory-only rewrite. v3 dispatched sub-agents into leased
worktrees and orchestrated them over Herdr; all of that is gone. Moving a
machine from v3 is one script, below.

## Getting started

```sh
npm run setup                     # install, build, npm link
yan vault init personal --remote git@github.com:you/yan-vault-personal.git
```

`yan vault init` needs an empty repository on your forge first. On a second
machine, `yan vault clone <url>` instead.

Then `cd` into a clone you work in and type `yan`.

## What there is

Bare `yan`, at a terminal, picks an open task or starts one, and runs the
agent on it in this terminal. A new task started inside a git clone can have
a worktree, cut on `yan/<id>` from origin's default branch. `--cli codex`
runs another agent this once; anything after `--` goes to the agent as it is.

For you:

- `yan ls` — every open task, one line each; `--status all` for the rest
- `yan peek [id]` — one task: its tree, brief, deliverables and newest drafts
- `yan done [id]` — close a task and give its worktree back; `--abandon "<why>"`
- `yan draft [id]` — your own notes about a task, in your editor
- `yan ui` — a work report of every task, in the browser
- `yan vault …` — init, clone, use, pull, push, where, ls

For the agent:

- `yan log` — what earlier sessions settled; `yan log agreed|changed|paused "<line>"` records one
- `yan deliverable add|edit|done|abandon` — the task's goal, changed only when you change it
- `yan learn add|ls` — a learning, written only when you ask for one

`yan <command> --help` says the rest. Every command that takes a task reads
`$YAN_TASK` when none is given, which is what `yan` sets for the agent it
starts.

## Where things are

```
<vault>/                       a git repository, one per context (personal, work)
  vault.json                   { version: 2, name, created }
  config.json                  { cli, model, effort }: the agent bare yan starts
  learnings/<topic>.md         front matter (name, description) and the text
  tasks/<id>/
    task.json                  title, state, repo URL, deliverables
    brief.md                   prose: why the task exists
    log.md                     - MM-DD  type  line, appended only
    drafts/<draft-id>.md       yours, in the format of the `draft` CLI
    artifacts/                 whatever the work produced worth keeping
~/.yan/config.json             which vaults this machine has, and the active one
~/.yan/trees/<repo>-<hash>/    the worktree pool: <slot>/<repo>/ and leases/
```

The pool keeps its trees. Returning one resets and cleans it but keeps what
git ignores, so the next task in that slot starts with `node_modules` in
place. `yan done` refuses to return a tree holding uncommitted or unpushed
work; `--force` throws that work away, and never the branch.

[`docs/v4/design.md`](docs/v4/design.md) is the design, with the reasons.

## Moving from v3

On each machine, after pulling this code and running `npm run build`:

```sh
node scripts/migrate-v4.mjs --dry-run    # what would change
node scripts/migrate-v4.mjs              # do it
```

It rewrites every registered vault to version 2, moves `~/.yan-trees` to
`~/.yan/trees` and repairs git's links to the trees, and drops `clone_root`
from `~/.yan/config.json`. A progress bar shows each step. Nothing is
committed: look at `git -C <vault> status`, then `yan vault push`. A vault is
shared, so migrate it on one machine, push, and `git pull` it on the others
before running the script there; they skip it and only move their pool.

The top of [`scripts/migrate-v4.mjs`](scripts/migrate-v4.mjs) lists every
change it makes.

## Tests

`npm test` builds and runs everything. `npm run check:ui` clicks through the
page `yan ui` writes in headless Chrome, against the fixture vault in
`tests/fixtures/ui-vault/`; it is not part of `npm test`, because it needs
Google Chrome.

## Third-party material

`templates/ui/fonts/` holds two woff2 subsets of **ChillRoundF** (寒蝉全圆体)
by ChillType, the face `yan ui` draws its report in, under the SIL Open Font
License 1.1. `templates/ui/fonts/OFL.txt` is the licence and the copyright
notice, and the `README.md` beside it says what is in the subsets and how they
were cut. Everything else here is yan's own.
