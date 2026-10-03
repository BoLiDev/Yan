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

`src/records/` owns the vault's files: `task` (task.json and brief.md), `log`,
`drafts`, `learnings`, `repos` (repos.json, and where each is cloned). `src/externals/` wraps outside things: `worktree` (the
pool) and `harness` (how claude, codex and agy are started). `src/util/` is
below all of them. `src/ui/prompts.ts` is the only place that prompts, and
only `src/cli/` imports it.
