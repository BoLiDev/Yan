---
name: Folder trust on a new repository
description: Claude parks on "Do you trust this folder" in the worktrees of a repository it has never opened
---

# Folder trust on a new repository

- **Symptom:** every shift dispatched into a new repository starts and then sits
  still; the pane shows the folder-trust dialog, and herdr reads it as idle.
- **Cause:** the main clone was never trusted, and a pool tree does not inherit
  trust from it.
- **Fix:** in `~/.claude.json`, set `hasTrustDialogAccepted: true` under
  `projects` for the main clone and for every pool slot path. The keys must use
  forward slashes.
- **Source:** found by yan, t109, 2026-08-29.

This file is an example of the shape. `yan session-start` indexes every `.md`
in `<vault>/mem/learnings/` by path, `name` and `description`, and yan opens the
file when that line matches the problem in front of it. A problem earns a file
when reading it shortens the next person's path: a trap the code does not show,
something that ought to be simple and is hard here, with what makes it hard, or
an unconventional design somebody would otherwise fight. One topic per file,
named for the topic, rewritten in place when it turns out wrong.
