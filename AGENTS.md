# Working on yan

yan is a small CLI that keeps notes for agent sessions: tasks, their problem,
deliverables, log and resources, `user`'s drafts, learnings, and a worktree
per repository a task works in. Read `README.md` for what it does.
`yan <command> --help` is the reference for each command.

## Layout

`src/cli/` holds the commands. Each top-level `src/cli/<name>.ts` exports a
`command` and is discovered from `dist/cli/` at run time; helpers live in
`src/cli/shared/`. Bare `yan`, the launcher, is
`src/cli/shared/launch.ts`.

`plugin/` is yan's skills, the plugin claude is started with.

`web/` is `yan serve`'s page, a React 19 and TypeScript app that Vite builds
into dist/web/, which the server serves. Server data is held by TanStack
Query and fetched again only when the server says that part of the vault
moved; the page's own state, its preferences and what it has seen, is a
zustand store. What serve sends the page is typed once, in
`src/cli/serve/wire.ts`, which serve builds its answers to and the page
imports as types alone. `npm run dev:web` serves the page with hot reload
against a `yan serve` already running ($YAN_SERVE, http://localhost:4747 by
default).

`src/records/` owns the vault's files: `task` (task.json and problem.md),
`log`, `drafts`, `learnings`, `repos` (repos.json, and where each is cloned).
`src/externals/` wraps outside things: `worktree` (the pool) and `harness`
(how claude, codex and agy are started). `src/util/` is below all of them.
`src/ui/prompts.ts` is the only place that prompts, and `src/ui/chain.ts`
draws what bare `yan` says between its questions; only `src/cli/` imports
either.

Outside `src/records/<m>/` and `src/externals/<m>/`, import only the
module's `index.ts`, and one external never imports another.
`scripts/check-module-boundaries.mjs` checks this on every build.

## Rules of the design

- Every piece of information has one writer. Structured state belongs to a
  command (task.json through `yan deliverable`, `yan resource`, `yan done`);
  prose belongs to a file the agent edits directly (problem.md). log.md is
  prose but appended only, so it goes through `yan log`.
- What an agent is told has four places. How to work in a task, and when to
  do each thing, goes in yan's skills (`plugin/skills/`), each skill's
  description saying when it is used, since that is the line an agent reads
  to choose one; claude is started with them, and they can be carried where
  yan cannot start the agent. Claude's opening prompt (`skillsPrompt` in
  `src/cli/shared/launch.ts`) only says the task is yan's, where its files
  go, which skills there are, and the one moment an agent would not think to
  look for a skill; where the files go is there too because an agent writes
  files whether or not it ran a skill first.
  codex and agy take no plugin, so `OPENING_PROMPT` tells them it all, and
  is kept in step with the skills. How to use a command goes in `--help`. A
  rule that belongs to one command goes in its one-line description, which
  is the line the agent reads when it scans `yan --help`.
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

`npm test` builds, the page included, then runs every test; the integration
tests run `bin/yan.mjs` against `dist/`, so they need the build.
`npm run typecheck` type-checks the tests, which the build does not, and the
page. The page's logic that runs without a browser is tested beside it in
`web/src/` (`*.test.ts`); its parts as a person uses them, drawn in
Chromium with serve stood in for at fetch, beside them too (`*.test.tsx`,
helpers in `web/src/testing/`); and the page against a real `yan serve`
in `tests/e2e/`. Those two need Playwright's Chromium, once per machine:
`npx playwright install chromium`. A command's own test sits beside it in
`src/`; a test through `bin/yan` goes in `tests/integration/`.

A test says what yan does, as someone using it would see it: what the page
shows and sends, what a command prints with `--json`, what lands in the vault.
Not the markup, the wording, or which internal function ran; and not a test
that only replays one bug's steps when the behaviour it broke can be tested
instead.

When a command, a file format or what the agent is told changes, update
`README.md` in the same commit.

## Commits

Commit on `main`. The subject is one lowercase sentence saying what yan now
does ("a returned tree lets go of its task's branch"), and the body says
why, in prose.
