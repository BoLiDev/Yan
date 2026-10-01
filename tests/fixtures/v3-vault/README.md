# A v3 vault, for the migration

What `scripts/migrate-v4.mjs` starts from, in `tests/integration/migrate.test.ts`.
Read-only: the test copies it and commits the copy before migrating it.

The ten tasks are the `yan ui` fixture as it was in v3. Around them is one of
each thing v4 drops, moves or rewrites:

- `repos.json` naming two of the three repositories the units use (`site`,
  `ledger`); `yan` is in no registry and stays a bare name
- `config.json` with `agents.yan` as codex, a model and an effort
- `mem/learnings/` with one learning, an empty `mem/user.md`
- `skills/collect-feedback.md`, `hooks/.gitkeep`, `.local/repos.json`, and
  a `.gitignore` written by v3
- t001: a brief starting with a BOM, a `run/` directory and a draft under
  `artifacts/drafts/`
- t002: a shift with a `run/` and an `outcome.md`, an artifact, and a log
  with v3 line types
- t007's `deliverable.json` does not validate; t008's `task.json` is not JSON
