# Working on yan

yan is a small CLI that keeps notes for agent sessions: tasks, their problem,
deliverables, log and resources, `user`'s drafts, learnings, and a worktree
per repository a task works in. Read `README.md` for what it does.
`yan <command> --help` is the reference for each command.

## Checking a change

`npm test` builds, the page included, holds the page to React's rules of
hooks and its other lint (`npm run lint:page`, oxlint, which needs no
TypeScript of its own), then runs every test; the integration tests run
`bin/yan.mjs` against `dist/`, so they need the build. An Effect that runs
on some changes and reads other values reads those through useEffectEvent;
a lint rule is not turned off for a line without a comment saying why.
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

Beyond the tests, `/monkey` in Claude Code sends subagents to use yan as
careless, curious or hostile people would, each in a sandbox of its own
(`.claude/skills/monkey/`: two machines sharing a vault, a fake claude, the
page in Chromium), and reports what they broke once another subagent has
reproduced it. It fixes nothing.

When a command, a file format or what the agent is told changes, update
`README.md` in the same commit.

## Commits

Commit on `main`. The subject is one lowercase sentence saying what yan now
does ("a returned tree lets go of its task's branch"), and the body says
why, in prose.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `BoLiDev/Yan`, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the repo root and ADRs in `docs/adr/`, both created only when a term or decision is settled. See `docs/agents/domain.md`.
