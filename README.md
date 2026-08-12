# `yan`

A work orchestration system for one person: you describe something that needs doing, `yan`
breaks it into pieces that can be handed out, each piece goes to a single-use sub-agent
working in an isolated git worktree, and the result is delivered as a merge request.

Status: **V3 implemented**. TypeScript on [Herdr](https://herdr.dev), on Git Bash (Windows)
and Linux. The MVP's bash-and-tmux runtime has been deleted; `bin/` holds three shell stubs
and nothing else.

**This repository is code.** Tasks, briefs, logs, outcomes, memory and the repository
registry live in a **vault**: a git repository of your own, one per context — personal
projects at home on GitHub, work on an internal GitLab — versioned and carried between
machines. Nothing private is kept here, which is what makes this clone shareable with a
colleague who will point it at their own vault ([docs/v3/td/INDEX.md](docs/v3/td/INDEX.md)).

## Getting started

```sh
npm run setup                          # install, build, link, doctor
# or step by step:
npm install
npm run build
npm link                               # once: put `yan` on PATH
yan doctor                             # checks everything below

# then, once: somewhere to keep tasks. Create an EMPTY repository on your
# forge first — that click is yours, not yan's.
yan vault init personal --remote git@github.com:you/yan-vault-personal.git
```

`npm run setup` runs the first block in order and finishes with `yan doctor`. Pass
`--skip-doctor` to stop before it. It does not create a vault: which forge you deliver to
is a decision, and a bootstrap script guessing it is exactly the guess V3 exists to stop.

On a second machine, or at the office, the same clone joins a different context:

```sh
yan vault clone git@github.com:you/yan-vault-personal.git   # a vault that exists
yan use work                                                # switch between them
cd ~/code && yan repo add                                   # say where clones are here
```

After `npm link`, you can run `yan` from any directory — it resolves `$YAN_HOME` to
this checkout, the same as `bin/yan doctor` from here. Re-run `npm link` after moving
the clone. Hooks and briefs that hardcode `$YAN_HOME/bin/yan` keep working unchanged.

`yan doctor` is the fastest way to find out whether this machine can run `yan`. It checks
`git`, `node`, a **global** git identity (a shift commits in a leased worktree, which sees
only the global config), the one remote-host CLI `remote_git.kind` selects, and Herdr —
its version against the generated types, and the integration for each agent kind you have
configured.

Then: `yan repo add` in the directory holding your clones (or `yan repo add <url>` to
clone one) → type `yan` → you are inside the task.

| Runtime | Notes |
| --- | --- |
| Git Bash (Windows) | nothing special; `node` is on `PATH` |
| Linux / WSL | `node` is usually nvm's, which a non-interactive shell does not see — source it, or point `agents.*` at an absolute path |

Codex works as the main agent. As a **shift** agent it is only usable where you have said
so: its first-run hook-review prompt is one Herdr does not classify as blocked, so a shift
would park on it silently. `yan doctor` says this at the point it can still be answered;
the measurements are in [docs/v2/td/evidence.md §13](docs/v2/td/evidence.md).

Tests: `npm test`. That is the whole suite — unit, integration, and the e2e tests that
skip loudly when Herdr or a real forge is absent.

## Where to start reading

**[docs/v3/td/INDEX.md](docs/v3/td/INDEX.md)** is the newest layer: the three places yan's
state lives (code, vault, machine), why `$YAN_HOME` stopped being all three, and how a
machine carries two contexts without mixing them.

**[docs/v2/td/INDEX.md](docs/v2/td/INDEX.md)** is the runtime design: what V2 changed, what
it deliberately did not, and what was deleted. Each section links to the document that
argues one part in full — the terminal seam, supervision, orchestration, display, the CLI
UX, and the evidence every claim rests on.

**[docs/mvp/td/INDEX.md](docs/mvp/td/INDEX.md)** is still the backbone, and still wins any
argument about *design*: the principles, the glossary, the storage criteria, the branch
model, the forge layer, the authority table. Read its mechanisms as history — where it says
tmux, bash or `jq`, V2 says Herdr and TypeScript.

| Question | Document |
| --- | --- |
| Where tasks are kept, and how two contexts stay apart | [docs/v3/td/INDEX.md](docs/v3/td/INDEX.md) |
| What the current runtime is, and why | [docs/v2/td/INDEX.md](docs/v2/td/INDEX.md) |
| Why is it designed this way, and what is each part responsible for | [docs/mvp/td/INDEX.md](docs/mvp/td/INDEX.md) |
| The full argument for one part (memory, agents, supervision, branching, worktrees, delivery, boundaries, scope) | the matching file under `docs/mvp/td/`; every section of INDEX ends with a link |
| Where the code goes, what may call what, and how it is tested | [docs/v2/td/runtime.md](docs/v2/td/runtime.md), and [docs/mvp/td/architecture.md](docs/mvp/td/architecture.md) for the layering it inherited |
| How each claim about Herdr was measured | [docs/v2/td/evidence.md](docs/v2/td/evidence.md) |
| How the port was cut into phases | [docs/v2/plan/INDEX.md](docs/v2/plan/INDEX.md) |
| How V3 was cut into phases, and what the migration found | [docs/v3/plan/INDEX.md](docs/v3/plan/INDEX.md), [docs/v3/td/migration.md](docs/v3/td/migration.md) |

## Conventions

- The MVP technical design (`td`) is split by topic across `docs/mvp/td/`. Section numbers are part of each
  heading, and one numbering scheme runs across all of the files, so a given section number
  appears exactly once in the whole set. A reference from one `td` file to another
  therefore gives only the section number plus a link to click, and the reader does not have
  to know which file that section lives in.
- A reference that crosses out of `td` says which document and which section: the
  document name followed by the section number, again with a link. For example
  [`architecture.md` §3](docs/mvp/td/architecture.md#3-repository-layout).
  Keeping the document name and the anchor together stops the two from drifting apart.
- Documents that do not share `td`'s numbering are the exception when they point into
  it: they use the prefix `td` instead of a file name, for example
  [td §7](docs/mvp/td/worktree.md#7-worktrees). Since the section numbers run
  across every file, the number alone is enough to identify the section, and the link answers
  which file it is in.
- A bare section number with no link refers to a section of the current document. References
  within a single document are always written this way. `docs/mvp/td/architecture.md` (1–7)
  carries its own numbering and says so at the top.
- `docs/` is also the working area for design discussions. Anything a discussion produces
  (Markdown or HTML) goes here.
