# Working on yan

yan is a small CLI that keeps notes for agent sessions: tasks, their problem,
deliverables, log and resources, `user`'s drafts, learnings, and a worktree
per repository a task works in. Read `README.md` for what it does.
`yan <command> --help` is the reference for each command.

## Layout

`src/cli/` holds the commands. Each top-level `src/cli/<name>.ts` exports a
`command` and is discovered from `dist/cli/` at run time; helpers live in
`src/cli/shared/` and `src/cli/ui/`. Bare `yan`, the launcher, is
`src/cli/shared/launch.ts`.

`src/records/` owns the vault's files: `task` (task.json and problem.md),
`log`, `drafts`, `learnings`, `repos` (repos.json, and where each is cloned).
`src/externals/` wraps outside things: `worktree` (the pool) and `harness`
(how claude, codex and agy are started). `src/util/` is below all of them.
`src/ui/prompts.ts` is the only place that prompts, and only `src/cli/`
imports it.

Outside `src/records/<m>/` and `src/externals/<m>/`, import only the
module's `index.ts`, and one external never imports another.
`scripts/check-module-boundaries.mjs` checks this on every build.

## Rules of the design

- Every piece of information has one writer. Structured state belongs to a
  command (task.json through `yan deliverable`, `yan resource`, `yan done`);
  prose belongs to a file the agent edits directly (problem.md). log.md is
  prose but appended only, so it goes through `yan log`.
- What an agent is told has three places. When to do something goes in the
  opening prompt (`OPENING_PROMPT` in `src/cli/shared/launch.ts`), because an
  agent does not read help unprompted. How to do it goes in `--help`. A rule
  that belongs to one command goes in its one-line description, which is the
  line the agent reads when it scans `yan --help`.
- A vault is shared across machines through git, and machines update yan at
  different times. A change to its files keeps old ones readable and is
  readable by the yan before it: add optional fields rather than renaming,
  read an old file name as a fallback rather than moving files, and write
  task.json through `Task.edit`, which keeps fields it does not know. What
  belongs to one machine, such as where a repository is cloned, goes in
  `~/.yan/config.json`, never in the vault.
- No design documents. The reasons for how something is shaped go in the
  comment beside it and in the commit message; `README.md` says what yan
  does, as it does it now.

## Checking a change

`npm test` builds, then runs every test; the integration tests run
`bin/yan.mjs` against `dist/`, so they need the build. `npm run typecheck`
type-checks the tests, which the build does not. `npm run check:ui` clicks
through the page `yan ui` writes, in headless Chrome; run it when
`src/cli/ui/` or `templates/ui/` changes. A command's own test sits beside
it in `src/`; a test through `bin/yan` goes in `tests/integration/`.

When a command, a file format or what the agent is told changes, update
`README.md` in the same commit.

## Commits

Commit on `main`. The subject is one lowercase sentence saying what yan now
does ("a returned tree lets go of its task's branch"), and the body says
why, in prose.
