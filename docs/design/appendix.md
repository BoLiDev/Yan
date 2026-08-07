# Appendices

These three sections are lists to look things up in, not sections to read through. The decisions in the main documents point here.

## Appendix A. Memory read and write contract

| File | Who writes | When | Who reads | When |
| --- | --- | --- | --- | --- |
| `mem/user.md` | `yan` | only when `user` asks; rewritten in place | `yan` | at startup |
| `mem/repos.json` | `yan` | only through `yan repo-add` | `yan` | at startup, and when a repository is involved |
| `mem/learnings/*.md` | `yan` | once there is evidence; rewritten in place, dated, deleted when it goes stale | `yan` | on demand, only the parts that apply |
| `tasks/<id>/task.json` | `yan` | on creation, adding a `unit`, `unit set`, and declaring the task finished | `yan` | at startup |
| `tasks/<id>/brief.md` | `yan` | once at creation; revisions must be explicit | `yan`, `shift` | when `yan` starts; when a `shift` starts |
| `tasks/<id>/log.md` | `yan` | one line appended at the end of each `shift` and at each decision | `yan`, `user` | at startup; with `cat` |
| `tasks/<id>/report.md` | `shift` | before wrapping up | `yan`, future tasks | when the task wraps up; when a similar problem comes in |
| `tasks/<id>/artifacts/` | `shift` | at any time | `user` | after the task wraps up |
| `shifts/<sid>/brief.md` | `yan` | once before spawning | `shift` | the first thing it does |
| `shifts/<sid>/outcome.md` | `shift`, with `yan` as fallback | before clocking out | `yan`, the next `shift` | when a new `shift` starts |
| `run/meta.json` | the spawn script | at spawn time | `yan` | at startup, to rebuild the picture |
| `run/status` | `shift` | sparingly: only events that need `yan` to act | `yan` | when woken |

The reasoning behind the different write rules is in [§4.1](memory.md#41-who-may-write-what).

## Appendix B. File system boundary for `yan`

### Writable

| Path | What goes in it | Constraints |
| --- | --- | --- |
| `tasks/<id>/task.json` | decisions: units, `scope`, delivery history, the completion flag | written atomically |
| `tasks/<id>/log.md` | narrative progress | append-only; existing lines are never rewritten |
| `tasks/<id>/brief.md` | the task contract | once at creation; a revision must be explicit and logged |
| `shifts/<sid>/brief.md` | the work order for a `shift` | once before spawning |
| `shifts/<sid>/run/meta.json` | tree path, terminal id, shift branch name | at spawn time |
| `shifts/<sid>/run/` | deleted as a whole directory | when clocking out |
| `mem/learnings/*.md` | operational facts | may be written without asking, but rewritten in place, dated, and backed by evidence — never appended to indefinitely |
| `mem/repos.json` | the repository registry | only through `yan repo-add` |

### Read-only

| Path | Why |
| --- | --- |
| `repos/<repo>/` | a main clone. The only write allowed is `git fetch`. Never check out, never touch the working tree, never commit |
| `shifts/<sid>/run/status` | the event stream a `shift` writes; `yan` only reads it |
| `shifts/<sid>/outcome.md` | written by the `shift`. `yan` writes it only when a `shift` died without doing so, and marks it as written after the fact |
| `tasks/<id>/artifacts/` | written by the `shift`. `yan` may tidy it — rename files, add an index — but not change the contents |
| `mem/user.md` | written only when `user` asks |
| `conf/`, including `hooks/` | `user`'s local choices |
| `bin/`, `AGENTS.md` | `yan`'s own tools and its own instructions; it does not modify them at runtime |
| other `tasks/*/` | a `yan` only handles its own task |

## Appendix C. Script inventory

The steps of each subcommand, and whether it is atomic or orchestrating, are in [`architecture.md` §5](architecture.md#5-subcommands).

| Script | What it does |
| --- | --- |
| `yan repo-add` | register a repository and clone it into `repos/` |
| `yan task new` | create `tasks/<id>/` and write the brief |
| `yan unit add` | add a `unit` (`target` must be given explicitly) and create the integration branch |
| `yan unit set` | change `branch`, `target`, `mode`, or `scope`. When `branch` changes, decide `end` and archive the old round ([§6.4](branching.md#64-the-shape-of-a-unit)) |
| `yan start` | create the task's terminal container and start `yan` inside it |
| `yan session-start` | the full rebuild at startup, triggered by the SessionStart hook |
| `yan tree` | the built-in worktree pool: `get`, `return`, `status` ([§7](worktree.md#7-worktrees)) |
| `yan shift new` | dispatch a `shift` ([§5.3](agents.md#53-the-life-of-a-shift)) |
| `yan send` | send one line to a `shift` |
| `yan report` | called by a `shift`: append to `status` and touch `signal` |
| `yan wait` | the watcher itself, started in the foreground by autoarm, watching three sources ([§5.5](supervision.md#55-supervision)) |
| `yan drain` | read the wake file after the model has been woken |
| `yan state` | derive the current state from `meta` plus the terminal, git, and GitLab |
| `yan scope-check` | check the diff for paths outside `scope` |
| `yan shift done` | bring a `shift` back. The order of operations is in [§7](worktree.md#7-worktrees) |
| `yan sync` | bring the integration branch up to date with `target` |
| `yan mr` | open the outbound MR |
| `yan land` | merge it (requires authority) |
| `yan ls` | scan `tasks/` and render the queue |
| `yan open` | open a task directory or its artifacts |
| `hook-autoarm.sh` | the asyncRewake Stop hook ([§5.5](supervision.md#55-supervision)) |
| `hook-turnend-guard.sh` | the blocking Stop hook ([§5.5](supervision.md#55-supervision)) |
| `bin/lib-term.sh` | the terminal seam ([§5.7](agents.md#57-terminal-topology)) |
| `bin/lib-forge.sh` | the GitLab and GitHub seam ([§8.4](delivery.md#84-the-forge-layer)) |
