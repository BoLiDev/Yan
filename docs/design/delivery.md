# 8. Delivery modes

## 8.1 `mode` and authority

How far the work goes before it stops, and who may press merge, are separate dimensions. `yan` splits them explicitly: axis 1, `mode`, decides where the work stops; axis 2, authority, decides who may press merge ([§9.2](boundaries.md#92-external-side-effects)).

## 8.2 The three modes

| `mode` | Edits code | Commits | Pushes | Opens an MR | Deliverable | Final state |
| --- | --- | --- | --- | --- | --- | --- |
| `scout` | × | ✓ (scratch) | × | × | `report.md` plus `artifacts/` | `done: report` |
| `branch` | ✓ | ✓ | × | × | a clean local branch | `done: branch <name>` |
| `mr` | ✓ | ✓ | ✓ | ✓ | a GitLab MR | `done: mr <url>` |

These sit at two levels. `kind: scout | ship` belongs to the `task`, because it changes what is delivered. `mode: branch | mr` belongs to the `unit`, because different repositories want different delivery styles. The per-repository default is in `repos.json`, and a per-unit override goes in `task.json`.

A `scout`'s tree is declared to be disposable scratch space. It may get as dirty as it likes and may commit freely, because reproducing a bug and trying things out both need that. What it may not do is push or land anything, and once the report is written the whole tree is thrown away. This is far more practical than forbidding all changes.

The default `mode` is `mr` rather than `branch`, because pushing to a remote is the best backup available. `branch` is for repositories where you cannot push branches freely — branch protection, naming rules, or a push triggering an expensive CI run.

`mode` describes how the integration branch is delivered outward. At the shift branch level the route is always the same: an MR merged into the integration branch.

## 8.3 Enforcement

The first version does not spend effort building an isolation mechanism. Startup arguments are enough:

| Goal | How |
| --- | --- |
| stop stray edits, and save context | set the working directory to the main `scope` path, and add the rest of `scope` with `--add-dir`. Those directories are the agent's whole world |
| stop a `scout` from editing code | plan mode (on other harnesses, the equivalent read-only sandbox) |
| stop `branch` mode from pushing | one sentence in the brief |

The reasoning behind the last one: **branch protection on the GitLab server is the real last line of defence.** Pushing a branch by mistake is cheap and reversible — delete it — and anything genuinely serious is refused by the server. A client-side hook would only be a nicety.

The exact flags depend on what each harness's `--help` says at the time, so the spawn script keeps a small mapping table (harness → set the working directory, add a directory, read-only mode). Do not build an abstraction layer for it.

One cheap check is worth keeping: `yan scope-check <sid>` runs `git diff --name-only` and matches prefixes, once, before landing. It does not constrain the agent while it works; it reports anything outside `scope` before the work lands. The rule is "going outside `scope` requires expanding it explicitly", not "going outside `scope` is forbidden":

> While changing `apps/auth` you discover you have to touch a type in `apps/common`. This happens constantly in real work. Refusing outright would leave the agent stuck, or quietly working around the check. The rule is to edit `task.json` to widen `scope`, and add a line to `log.md`.

That blocks stray edits while still showing how the scope grew — and `scope` growing often usually means the task was split in the wrong places.

`sparse-checkout` is shelved. Using it requires first solving "the set of files you edit is not the set of files you need to build" (in a monorepo, compiling `apps/auth` usually needs its sibling packages present), and that is expensive. It can wait until context pressure is actually painful.

## 8.4 The forge layer

**Both GitLab and GitHub are supported**, because both are real needs: GitLab at work, GitHub outside it. There is a sizeable side benefit — once GitHub is supported, the first version's acceptance test can be run against `yan`'s own repository.

The design test here is Ousterhout's deep module: a narrow interface over a thick implementation. This layer qualifies. It exposes four verbs, and underneath it hides five differences between the two CLIs: argument shapes, terminology (MR versus PR), JSON shapes, authentication, and the CI model.

```
forge_mr_create      open an MR or PR, return the URL
forge_mr_state       merged | closed | open | unknown
forge_mr_merge       merge it
forge_ci_state       green | red | pending | none
```

**The failure to guard against is this layer degrading into a shallow module**, where every function is a one-line pass-through to `glab` or `gh`, return values leak out untouched, and the caller still has to know which system it is talking to. That is a pass-through method, the opposite of a deep module. The only way I can see to avoid it: **define the interface in `yan`'s own vocabulary, not as the union of the two forges' vocabularies.**

Three concrete constraints:

1. **Return values are a closed set defined by `yan`.** The four values of `forge_mr_state` were not picked at random — they are exactly the four cases [§6.4](branching.md#64-the-shape-of-a-unit) needs in order to decide `end`, one for one. Do not let a fifth one slip in.
2. **CI answers only green or red.** GitLab has one status for one pipeline; GitHub has N independent check runs plus the legacy status API. "Which job failed" does not line up between them, and forcing it to line up would drop information. What [§5.3](agents.md#53-the-life-of-a-shift) actually needs is "CI is red, dispatch a `shift` to fix it". Looking at the details is the `shift`'s job — and a `shift` is allowed to know which forge it is on, because it is reading, not deciding.
3. **Which forge a repository uses is a per-repository field in `repos.json`, not a global switch.** One `task` may well touch both a monorepo on the company's GitLab and a personal repository on GitHub, so the choice follows the repository, not the session.

Authentication is not unified. `gh` and `glab` each manage their own login, and this layer does not try to paper over that: the bootstrap check verifies that both CLIs are authenticated and names whichever one is missing. A self-hosted GitLab instance also needs `glab auth login --hostname`.

This is not the backend abstraction layer that [§11](scope.md#11-scope-of-the-first-version) rules out under "explicitly out of scope". What that rules out is a plugin framework. This has the same shape as `lib-term.sh` in [§5.7](agents.md#57-terminal-topology): **a few functions gathered into one file, not a framework.**
