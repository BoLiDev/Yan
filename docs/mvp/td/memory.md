# 4. Memory

## 4.1 Who may write what

`user.md` and the files under `learnings/` are written under different rules. A wrong entry in `learnings/` is cheap: the next time `yan` runs into the same thing, it corrects the file. Asking `user` for permission every time would just mean nothing ever gets written down. `user.md` is different, because it records judgements about a person; a wrong entry there keeps misleading `yan` for a long time.

So `yan` may write `learnings/` on its own. Each entry is rewritten in place rather than appended to, carries a date, and cites the evidence it came from. `user.md` is written only when `user` explicitly asks for it.

The full table of who writes each file, when, who reads it, and when, is in [Appendix A](appendix.md#appendix-a-memory-read-and-write-contract).

## 4.2 `log.md`, the narrative layer

JSON is a bad fit for "how far along are we". A separate `progress.md` is no better, because it would eventually disagree with the individual `outcome.md` files. So progress lives in an append-only log, one line per event:

```markdown
# t042 unify the auth header

- 08-04  s1 auth       parse the header              → !31 merged into the integration branch
- 08-05  s2 auth       call the parser from auth     → !33 merged into the integration branch
- 08-06  s3 auth       fix the type error CI found   → !35 merged into the integration branch
- 08-07  auth          outbound MR !88 → release/bigproject
- 09-01  decision      retarget to master (the big release has stabilised)
```

Because it is append-only it never produces a merge conflict, and one line per event is cheap enough that nobody skips it. `user` and the agents read the same file, so `cat log.md` is enough to see where things stand — there is no need to stitch together twenty `outcome.md` files. It is also the context a new `shift` gets: the whole file is short enough to paste into a brief.

## 4.3 Artifacts

A work repository is shared with other people, so you cannot put whatever you like into it. Prototype HTML pages, design notes, screenshots, performance charts, research data — all of these belong to the project, but none of them belong in the repository.

That gives one constraint:

> Artifacts must be written outside the worktree.

The reason is that the worktree gets wiped by `yan tree return`. If a `shift` writes a prototype inside the tree, both possible endings are bad: the file is deleted, or it gets committed into the work repository. So `yan` sets `YAN_TASK_DIR=$YAN_HOME/tasks/<id>` when it starts a `shift`, and the brief tells the agent to write its output to `$YAN_TASK_DIR/artifacts/`. The same rule also prevents an agent from casually committing a design document into a shared repository, which matters more than the context it saves.

Artifacts live as long as the `task` directory does, and are not deleted when a `shift` clocks out — most of their value comes after the task is over. Their main reader is `user`, so `yan open <id>` opens the directory directly, or opens an HTML file in a browser. There is no index; the directory listing and the file names are enough.

The line between this and `report.md`: the report holds conclusions, written for agents to read and for future tasks to reuse. `artifacts/` holds the output itself, the things a person looks at. A prototype HTML page is an artifact; "what this prototype proved" belongs in the report.

## 4.4 What not to store

Temporary paths, version numbers that will change, and copied-in snapshots of state. Anything the repository itself already explains, such as code structure or git history — that belongs in the repository's own `AGENTS.md`. And anything git or the forge already holds as the source of truth.
