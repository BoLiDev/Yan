# `yan`

A work orchestration system for one person: you describe something that needs doing, `yan`
breaks it into pieces that can be handed out, each piece goes to a single-use sub-agent
working in an isolated git worktree, and the result is delivered as a merge request.

Status: **V3 implemented**. TypeScript on [Herdr](https://herdr.dev), on Git Bash (Windows)
and Linux. The MVP's bash-and-tmux runtime has been deleted; `bin/` holds two stubs, the
bash `yan` and the `yan.mjs` npm puts on PATH, and nothing else.

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

Which models run is the vault's `config.json`, starting from
[`templates/vault/config.example.json`](templates/vault/config.example.json). `agents.yan`
and `agents.shift` are the defaults — a CLI, and optionally a `model` and `effort`. Every
shift is dispatched as one of three fixed scenarios, `explore`, `coding` and `uix`, and
each needs at least one tier you define: a description the main agent chooses by, and
the CLI, model or effort that tier overrides, and the skills its shift invokes first. The main agent can pick a tier; it cannot
name a model, so nothing runs that you did not configure. `yan doctor` lists every tier
with what it really runs.

Then: `yan repo add` in the directory holding your clones (or `yan repo add <url>` to
clone one) → type `yan` → you are inside the task.

| Runtime | Notes |
| --- | --- |
| Git Bash (Windows) | nothing special; `node` is on `PATH` |
| Linux / WSL | `node` is usually nvm's, which a non-interactive shell does not see — source it, or point `agents.*` at an absolute path |

Codex works as the main agent. As a **shift** agent it is only usable where you have said
so: its first-run hook-review prompt is one Herdr does not classify as blocked, so a shift
would park on it silently. `yan doctor` says this at the point it can still be answered.

Agy — the Antigravity CLI — works as the main agent. Set `agents.yan` to
`{ "cli": "agy", "model": … }` (`agy models` lists the ids; with no
model, agy chooses its own). Two things differ from the other two:

- It has no notion of the directory it was started in. Its working set is the workspace
  named by `--add-dir`, and with an empty one it invents a project under `~/.gemini` and
  writes there — so `yan continue` passes `--add-dir $YAN_HOME`, which is also what makes
  its hooks in `.agents/hooks.json` discoverable at all.
- The first run in a new workspace stops on *"Do you trust the contents of this project?"*,
  which `--dangerously-skip-permissions` does not cover and Herdr reads as `idle` rather
  than `blocked`. The main agent meets it in your own pane, so answer it once.

A shift tells the main agent what happened by typing one line into its pane, with
`yan report`; nothing watches a shift, and `yan state <sid>` answers on demand. A line
that will not go — the main agent is in a dialog, or none is running — is kept and
listed by `yan show` and at the next session start. One that would land while you are
typing in the main agent's pane waits for your line to go, up to three minutes, and then
fails so the shift tries again later.

The one hook in `.claude/settings.json`, `.codex/hooks.json` and `.agents/hooks.json` is
the MAIN AGENT's: it rebuilds the picture at session start. A shift working on this
repository sits in a worktree that carries the same registration, so its own harness
fires it too. `YAN_SID` is what tells the two apart: the spawn step sets it in every
shift's environment and the main agent never has it. `yan session-start` checks it and
prints one line saying whose picture this is instead of the picture.

The root `AGENTS.md` is the main agent's prompt, read by all three harnesses.

Tests: `npm test`. That is the whole suite — unit, integration, and the e2e tests that
skip loudly when Herdr or a real forge is absent.

## Where to start reading

**[docs/v3/td/INDEX.md](docs/v3/td/INDEX.md)** is the design as it stands: the three places
yan's state lives (code, vault, machine), why `$YAN_HOME` stopped being all three, and how a
machine carries two contexts without mixing them. Each section links to the document that
argues one part in full.

The principles under it are short enough to give here:

1. **Do not store state you can derive.** The directory structure, git and the forge are the
   source of truth.
2. **One owner per piece of information:** one writer, and one point where it is read.
3. **Prose makes the judgements;** commands do the steps that need none.
4. **`user` and the agents use the same entry point.** Every action is a CLI command `user`
   can run too, and both see the same state.
5. **Anything irreversible goes through a command, and is refused by default.**

The root `AGENTS.md` is the rest of the design in the form the main agent follows it: what a
task, a unit and a shift are, the branch model, and the authority table.

| Question | Where |
| --- | --- |
| Where tasks are kept, and how two contexts stay apart | [docs/v3/td/INDEX.md](docs/v3/td/INDEX.md) |
| What each command does, and what V3 changed | `yan <command> --help`, and [docs/v3/td/cli.md](docs/v3/td/cli.md) |
| What the main agent does, and what it may do without asking | [AGENTS.md](AGENTS.md) |
| Where the code goes, and what may call what | `src/`: `externals/` wraps each outside tool (the git hosts, Herdr, the worktree pool, the agent harnesses), `records/` owns the vault's files, `cli/` is the commands. [`scripts/check-module-boundaries.mjs`](scripts/check-module-boundaries.mjs) states the rules, and `npm run build` enforces them |
| How V3 was cut into phases, and what the migration found | [docs/v3/plan/INDEX.md](docs/v3/plan/INDEX.md), [docs/v3/td/migration.md](docs/v3/td/migration.md) |

## Third-party material

One thing in this repository was not written for it. `templates/ui/fonts/` holds two
woff2 subsets of **ChillRoundF** (寒蝉全圆体) by ChillType, the face `yan ui` draws its
work report in, under the SIL Open Font License 1.1 — `templates/ui/fonts/OFL.txt` is
the licence and the copyright notice, and the `README.md` beside it says what is in the
subsets, how they were cut and why the family they declare is called "Yan Round".
Everything else here is yan's own.

## Conventions

- Each document under `docs/v3/td/` numbers its own sections, and the number is part of the
  heading. A reference to another document names it and the section, with a link, for
  example [`vault.md` §5](docs/v3/td/vault.md#5-sync), so the name and the anchor cannot
  drift apart.
- A bare section number with no link refers to a section of the current document.
- `docs/` is also the working area for design discussions. Anything a discussion produces
  (Markdown or HTML) goes here.
