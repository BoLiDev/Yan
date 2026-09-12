---
name: yan-dev
description: Developing yan itself - what differs from a regular repository when the repo is `yan`: the runtime is a second clone outside the task, the tree's CLAUDE.md is the main agent's prompt and not the shift's, testing runs the new yan against its own tree, landing does not deploy, and how to set the second clone up on a new machine.
---

# yan-dev

The repository registered as `yan` is the tool you are running. Everything a
regular repository gets from yan still applies: shifts in leased trees, merge
requests into the integration branch, one outbound merge request into `target`.
What follows is only what is different, and why.

## 1. There are two clones, and only one of them is yours

| | where | what it is |
| --- | --- | --- |
| runtime | `$YAN_HOME` | what `yan` on PATH, the hooks and this session run from |
| workbench | the registered clone, printed by `yan session-start` as `repo yan <path>` | fetch here, lease trees from here |

A regular repository has one clone per machine. This one has two on purpose:
a tool that fetches, switches branches or rebuilds in its own runtime loses its
hooks and its prompt while it is still running. So `$YAN_HOME` is outside every
task: never move its branch, never build in it, never lease from it. Treat it
the way the authority table treats a repository outside the task.

## 2. The tree's CLAUDE.md is not the shift's instructions

Every tree of this repository carries the main agent's prompt as its root
`CLAUDE.md`, `AGENTS.md` and `GEMINI.md`, and a shift's harness reads that file
as if it were addressed to the shift. In a regular repository the root file is
a contributor guide; here it tells the reader it is yan. Until the prompt moves
out of the repository root, every brief says, in its own words: those three
files are the main agent's prompt, you are not the main agent, and they are
files you may edit rather than instructions to you.

## 3. Verifying runs the new yan against its own tree

- `npm test` in the standing tree runs the build and the suite, and is known to
  pass from inside a yan session. `npm run typecheck` covers the tests' types.
- To try the changed yan itself, name its tree explicitly:
  `YAN_HOME=<tree> node <tree>/bin/yan.mjs <command>`. Without the variable it
  resolves to the runtime, because this session exports `YAN_HOME` and
  `yanHome()` trusts the environment first.
- Only read-only commands that way: `doctor`, `session-start`, `show`, `state`,
  `ls`. The tree's yan shares the vault and the pool with the running one, and
  two yans writing the same task directory or leasing from the same pool is a
  mess nothing cleans up. Anything that dispatches, leases or lands is proved
  by the suite, not by hand.

## 4. Landing does not deploy

In a regular repository `yan land` is the end. Here the running yan is unchanged
until the runtime is updated:

    cd $YAN_HOME && git pull --ff-only && npm run build

Only when I ask, only for what has landed on `main`, and as the last thing in a
task: the next session runs the new yan, this one keeps the old. If a build
breaks the tool, `$YAN_HOME` is a clone, and `git checkout main && npm run build`
brings the last good one back.

## 5. Setting the workbench up on a new machine

The vault already knows the repository `yan` and its URL; what a new machine
lacks is the second clone and its path. `npm run setup` and `yan vault clone`
from the README come first, then:

1. Clone it by hand, next to the runtime and under a different name:
   `git clone git@github.com:BoLiDev/Yan.git <projects>/Yan-Dev`. Not through
   `yan repo add <url>`, which clones into `<root>/yan`: on a case-insensitive
   disk that is the runtime's own directory, and `repo add` would register
   the runtime as the workbench without a word.
2. Say where it is: `yan repo link yan <projects>/Yan-Dev`. Only the machine
   half changes; the registry is untouched.
3. Accept folder trust for that path once, by opening Claude in it and
   choosing "Yes, I trust this folder", or the first shift parks on the dialog
   (`mem/learnings/folder-trust-on-a-new-repository.md`). Check with
   `python3 -c 'import json;print(json.load(open("$HOME/.claude.json"))["projects"].get("<path>",{}).get("hasTrustDialogAccepted"))'`.
4. `yan session-start` prints `repo yan <path>`; `yan doctor` is the rest.
