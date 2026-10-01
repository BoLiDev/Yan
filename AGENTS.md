# Working on yan

yan is a small CLI that keeps notes for agent sessions: tasks, their log and
deliverables, `user`'s drafts, learnings, and a worktree per task. Read
`README.md` for what it does and `docs/v4/design.md` for why it is shaped this
way. `yan <command> --help` is the reference for each command.

## Layout

`src/cli/` holds the commands. Each top-level `src/cli/<name>.ts` exports a
`command` and is discovered from `dist/cli/` at run time; helpers live in
`src/cli/shared/` and `src/cli/ui/`. Bare `yan`, the launcher, is
`src/cli/shared/launch.ts`.

`src/records/` owns the vault's files: `task` (task.json and brief.md), `log`,
`drafts`, `learnings`. `src/externals/` wraps outside things: `worktree` (the
pool) and `harness` (how claude, codex and agy are started). `src/util/` is
below all of them. `src/ui/prompts.ts` is the only place that prompts, and
only `src/cli/` imports it.

`scripts/check-module-boundaries.mjs` states the import rules, and
`npm run build` enforces them: a module under `externals/` or `records/` is
reached only through its `index.ts`, and one external never imports another.

## Rules

- Prompts are for a person at a keyboard. Anything an agent runs must work
  with no terminal and refuse, naming the flag, when a value is missing.
- Exit 2 is "called wrongly" and only `YanError.usage` produces it. Exit 1
  is "tried and refused or failed".
- What the agent is told at launch (`OPENING_PROMPT`) stays minimal. Add
  to it only for when to do something; how belongs in `--help`.
- Nothing pushes except `yan vault push`, and no force flag reaches git.
- A returned tree is cleaned with `-fd`, never `-x`.

## Checking a change

`npm test` builds, checks boundaries and runs every test. A module's own
test sits beside it in `src/`; command-level tests are in
`tests/integration/` and run the built `bin/yan.mjs` against a throwaway
vault. Run `npm test` before you call a change done, and look at the real
output of the command you changed, not only the tests.

## Writing

File and function comments are `/** */` blocks of plain prose saying why,
matching what is there. Commit messages say what is now true, in one line,
in the present tense.
