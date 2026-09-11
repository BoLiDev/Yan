# Appendices

These sections are lists to look things up in, not sections to read through. The decisions in the main documents point here.

## Appendix A. Memory read and write contract

| File | Who writes | When | Who reads | When |
| --- | --- | --- | --- | --- |
| `mem/user.md` | `yan` | only when `user` asks; rewritten in place | `yan` | printed at session start |
| `mem/repos.json` | `yan` | only through `yan repo-add` | `yan` | at startup, and when a repository is involved |
| `mem/learnings/*.md` | `yan` | a problem that took real effort and will recur — its own, or one from a shift's Learnings, judged with `user` — or a rule `user` states; rewritten in place when wrong; one topic per file with `name` / `description` front matter | `yan`, `shift` | the index at session start and in every shift brief; a file when a problem matches it |
| `tasks/<id>/task.json` | `yan`, through commands only | on creation; `unit add` / `unit set` in the turn `user` says something that moves a field; `mr`, `land`, `done` | the commands; `yan` | when acting; at session start |
| `tasks/<id>/brief.md` | `yan` | at creation; after the first alignment; in the turn a deliverable is added, dropped or replaced | `yan`, colleagues | printed at session start; as the outbound MR body |
| `tasks/<id>/log.md` | commands, and `yan` through `yan log` | one typed line per event, in the turn it happens ([§4.3](memory.md#43-logmd-the-tasks-story)) | `yan`, `user` | every `agreed` / `changed` line and the last 20 at session start; in full on demand |
| `tasks/<id>/artifacts/` | `shift`, `yan` | when there is a by-product worth looking at: research, prototype, design, screenshot | `user`, `yan`, `shift` | when a log line or a brief points at it |
| `shifts/<sid>/brief.md` | `yan` | once before spawning | `shift` | the first thing it does |
| `shifts/<sid>/outcome.md` | `shift`, with `yan` as fallback | before `yan report done`, which refuses without it | `yan` | after `done`, before merging: the source of the `delivered` line; its Learnings section is where most learnings start |
| `run/meta.json` | the spawn script | at spawn time | `yan` | at startup, to rebuild the picture |
| `run/status` | `shift` | sparingly: only events that need `yan` to act | `yan` | when woken |

The reasoning behind the different write rules is in [§4.1](memory.md#41-who-may-write-what), and behind the triggers in [§4.2](memory.md#42-triggers-not-frequency).

## Appendix B. File system boundary for `yan`

### Writable

| Path | What goes in it | Constraints |
| --- | --- | --- |
| `tasks/<id>/task.json` | decisions: units, `scope`, delivery history, the completion flag | written atomically |
| `tasks/<id>/log.md` | the task's story | append-only, one typed line per event; written through commands and `yan log` |
| `tasks/<id>/brief.md` | the task contract as it stands | rewritten when a deliverable changes, with an `agreed` line logged beside it |
| `shifts/<sid>/brief.md` | the work order for a `shift` | once before spawning |
| `shifts/<sid>/run/meta.json` | tree path, terminal id, shift branch name, agent CLI | at spawn time |
| `shifts/<sid>/run/` | deleted as a whole directory | when clocking out |
| `mem/learnings/*.md` | what to do when something recurs | may be written without asking, but rewritten in place, dated, and with its source — never appended to indefinitely |
| `mem/repos.json` | the repository registry | only through `yan repo-add` |

### Read-only

| Path | Why |
| --- | --- |
| `repos/<repo>/` | a main clone. The only write allowed is `git fetch`. Never check out, never touch the working tree, never commit |
| `shifts/<sid>/run/status` | the event stream a `shift` writes; `yan` only reads it |
| `shifts/<sid>/outcome.md` | written by the `shift`. `yan` writes it only when a `shift` died without doing so, and marks it as written after the fact |
| `tasks/<id>/artifacts/` | written by the `shift`, or by `yan` for its own research and visuals. `yan` may tidy a shift's — rename files, add an index — but not change the contents |
| `mem/user.md` | written only when `user` asks |
| `conf/` | `user`'s local choices; see [Appendix D](#appendix-d-configuration) |
| `bin/`, `AGENTS.md` | `yan`'s own tools and its own instructions; it does not modify them at runtime |
| other `tasks/*/` | a `yan` only handles its own task |

## Appendix C. Script inventory

The steps of each subcommand, and whether it is atomic or orchestrating, are in [`architecture.md` §5](architecture.md#5-subcommands).

| Script | What it does |
| --- | --- |
| `yan repo-add` | register a repository and clone it into `repos/` |
| `yan task new` | soft path: title, description, repos, monorepo-aware `scope`, unit(s), then enter the task container; hard path: same with flags ([cli-ux.md](cli-ux.md)) |
| `yan unit add` | add a `unit` (`target` must be given explicitly) and create the integration branch; soft path may offer repo/package select |
| `yan unit set` | change `branch`, `target`, `mode`, or `scope`. When `branch` changes, decide `end` and archive the old round ([§6.4](branching.md#64-the-shape-of-a-unit)) |
| `yan continue` | create or attach the task's terminal container and start `yan` inside it; soft path selects the task when no id ([§5.6](agents.md#56-harness-requirements), [cli-ux.md](cli-ux.md), [Appendix D](#appendix-d-configuration)) |
| `yan session-start` | the full rebuild at startup, triggered by the SessionStart hook |
| `yan tree` | the built-in worktree pool: `get`, `return`, `status` ([§7](worktree.md#7-worktrees)) |
| `yan shift new` | dispatch a `shift`; agent from `config.json` `agents.shift` or `--agent` ([§5.3](agents.md#53-the-life-of-a-shift), [§5.6](agents.md#56-harness-requirements)) |
| `yan send` | send one line to a `shift` |
| `yan report` | called by a `shift`: append to `status` and touch `signal` |
| `yan wait` | the watcher: long form (Claude autoarm) or `yan wait --seconds N` (Codex checkpoint); three sources ([§5.5](supervision.md#55-supervision)) |
| `yan drain` | read the wake file after the model has been woken |
| `yan state` | derive the current state from `meta` plus the terminal, git, and the forge |
| `yan scope-check` | check the diff for paths outside `scope` |
| `yan shift done` | bring a `shift` back. The order of operations is in [§7](worktree.md#7-worktrees) |
| `yan sync` | bring the integration branch up to date with `target` |
| `yan mr` | open the outbound MR |
| `yan land` | merge it (requires authority) |
| `yan ls` | without an id: render the queue. With `<id>`: print one task's units and live shifts, including each shift's branch and worktree absolute path (`--json` optional) |
| `yan open` | open a task directory or its artifacts |
| `hook-autoarm.sh` | Claude-only asyncRewake Stop hook ([§5.5](supervision.md#55-supervision)) |
| `hook-turnend-guard.sh` | blocking Stop hook for Claude and Codex ([§5.5](supervision.md#55-supervision)) |
| `bin/lib-term.sh` | the terminal seam ([§5.7](agents.md#57-terminal-topology)) |
| `bin/lib-forge.sh` | the remote git seam: GitHub / GitLab behind four verbs ([§8.4](delivery.md#84-the-forge-layer)) |

## Appendix D. Configuration

Everything `user` sets for this machine. The design documents say *why* a setting exists; the shapes and a full sample live here.

**User-level settings are one file: `conf/config.json`.** JSON, not YAML — `jq` is already a hard dependency ([§2](INDEX.md#2-storage-criteria)), so a second format would buy nothing. The file is local and gitignored ([§3](INDEX.md#3-directory-layout), [§10](boundaries.md#10-seams-for-outside-authorities)).

Two things stay beside it, not inside it:

| Path | Why it is separate |
| --- | --- |
| `mem/repos.json` | the repository registry, written by `yan repo-add`. It grows with every clone and is registry data, not machine preference |
| `conf/hooks/*` | opt-in executables ([§10](boundaries.md#10-seams-for-outside-authorities)). Scripts are not JSON fields |

### `conf/config.json` fields

| Field | Required | Values | Notes |
| --- | --- | --- | --- |
| `version` | yes | integer | same migration hook as every other JSON file |
| `agents.yan` | yes | `claude` \| `codex` | `yan continue` / enter-after-`task new` launches this CLI ([§5.6](agents.md#56-harness-requirements), [cli-ux.md](cli-ux.md)) |
| `agents.shift` | yes | any CLI that meets [§5.6](agents.md#56-harness-requirements) | `yan shift new` default; override one dispatch with `--agent` |
| `forge.kind` | yes | `github` \| `gitlab` | one forge per `$YAN_HOME` ([§8.4](delivery.md#84-the-forge-layer)) |
| `forge.host` | when `kind` is `gitlab` | hostname, no scheme | never inferred from a clone URL |
| `backend` | no | `tmux` \| `herdr` | defaults to `tmux` ([§5.7](agents.md#57-terminal-topology)) |

### `mem/repos.json` fields (per repository)

| Field | Default | Notes |
| --- | --- | --- |
| `url` | — | clone URL |
| `mode_default` | `mr` | [§8.2](delivery.md#82-the-three-modes) |
| `pool_size` | `8` | [§7](worktree.md#7-worktrees) |

No forge field here — forge is machine-global in `config.json`.

### Sample

Company laptop (Codex as `yan`, Claude as the usual shift, self-hosted GitLab):

```
$YAN_HOME/
  conf/
    config.json
    hooks/
      branch-name          # optional executable
  mem/
    repos.json
```

`conf/config.json`:

```json
{
  "version": 1,
  "agents": { "yan": "codex", "shift": "claude" },
  "forge": { "kind": "gitlab", "host": "gitlab.company.internal" },
  "backend": "tmux"
}
```

`mem/repos.json`:

```json
{
  "monorepo-x": {
    "url": "git@gitlab.company.internal:team/monorepo-x.git",
    "mode_default": "mr",
    "pool_size": 3
  },
  "service-y": {
    "url": "git@gitlab.company.internal:team/service-y.git",
    "mode_default": "branch",
    "pool_size": 8
  }
}
```

Personal machine: same file, flip `agents.yan` to `claude` if desired, and set `"forge": { "kind": "github" }` (no `host`).
