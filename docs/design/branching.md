# 6. The branch model

## 6.1 Branch structure

```
target (master / release/x / any branch)
 └─ integration branch (the working branch for this round) ———→ outbound MR —→ target
      ├─ shift branch s1  → MR → merged into the integration branch → shift s1 clocks out
      ├─ shift branch s2  → MR → merged into the integration branch → shift s2 clocks out
      └─ shift branch s3  ... (these can run at the same time, each in its own worktree)
```

This structure settles three things at once. The life of a `shift` gets an objective end condition: its branch is merged, so it clocks out. Concurrent agents get isolation: each has its own branch and its own tree. And progress gets somewhere to accumulate: a new `shift` branches from the integration branch's current head.

Note that the integration branch only represents the current round. It gets replaced wholesale; see §6.3. So "keep working within this round" and "the last round has already been delivered or abandoned" are two different mechanisms, and should not be treated as one.

## 6.2 Two levels of review

This comes free with the structure; it was not added on top:

| MR | Merges into | Who reviews it | What it is |
| --- | --- | --- | --- |
| shift branch → integration branch | a branch `user` owns | `user` plus CI, no colleagues involved | an internal checkpoint |
| integration branch → `target` | `target` | a formal review by colleagues | the outward delivery |

Colleagues see one MR, so they are not buried in noise.

## 6.3 How the integration branch changes

Three ways of moving forward, plus one way of starting over:

| Change | Who does it | Where it is recorded |
| --- | --- | --- |
| absorb a shift branch | the `shift`'s MR | git merge history |
| catch up with `target` | `yan sync` | git |
| change `target` | `yan unit set --target`, and `user` has to ask for it | the `unit.target` field |
| replace the integration branch entirely | `yan unit set --branch`, and `user` has to ask for it | the `unit.branch` field, and the old value moves into `history[]` |

**Catching up with `target` must never be given to a shift branch's agent.** That agent only sees its own small change; asking it to rebase the whole integration branch is a disaster. `yan sync` is a script action, not a `shift`: lease a tree → fetch → rebase or merge `target` → push → return the tree. No agent is involved, and a `shift` is only dispatched if there are conflicts to resolve. Its timing is fixed: sync before starting each new `shift`, so the new shift branch comes off the head that has just caught up. That keeps conflicts in one place — the integration branch against `target` — instead of scattering them across every shift branch to be solved again and again.

The last row is the one this model is easiest to miss: **the integration branch is not long-lived.** The way the work actually goes is that okt cuts a `2.0.1`, the work is done, it ships, it merges into master, feedback arrives, and then a `2.0.2` is cut. So a unit's integration branch is replaced outright rather than pushed forward forever.

That gives "we need to change something" three different shapes, with completely different mechanisms:

|  | How the last round ended | What to do | The new branch's base |
| --- | --- | --- | --- |
| within the same round | the integration branch has not merged into `target` yet | dispatch a new `shift`, branch off the current integration branch, merge back into it | the current integration branch |
| feedback after delivery | already merged into `target`, and closed | start a new round: okt cuts `2.0.2` | `target`, which already contains the last round |
| abandoned | dropped for some reason, never merged | also a new round, but marked as abandoned | the old branch itself, so the work is not lost |

The last two both use `yan unit set --branch <new branch>`. The only difference is how they are recorded in the history.

Changing `target` is not just bookkeeping either. Switching from `release/x` to `master` means the integration branch has to be rebased onto the new `target`, which may hit a pile of conflicts, and may need a `shift` to sort out.

## 6.4 The shape of a `unit`

```json
{ name: auth, repo: monorepo-x, scope: [apps/auth], needs: [proto],

  branch: 2.0.4,  target: master,  mode: mr,
  mr: https://gitlab.../merge_requests/88,

  history: [
    { branch: 2.0.1, target: master, at: 2026-08-20,
      end: delivered, mr: https://gitlab.../merge_requests/31 },
    { branch: 2.0.3, target: master, at: 2026-08-25,
      end: abandoned }
  ] }
```

The current state is four mutable scalars — `branch`, `target`, `mode`, `mr` — because the only operational thing `yan` ever needs is "which branch does a new `shift` branch off", and that is one string. `mr` is the outbound MR for the current round, written when `yan mr` opens it.

`history[]` is append-only: once an entry is written it is never touched again. It is kept separate from the current state rather than being "the current state is the last array element", because the current state is read often, and append-only is a cleaner rule when nothing else is mixed into it.

Each entry has at most five fields, and each one earns its place:

| Field | Why it is stored |
| --- | --- |
| `branch` | the point of the record: which branch was used |
| `target` | where it was merged. It can differ from the current value, for example `2.0.1` went to a release branch and later rounds went to master |
| `at` | when it was retired. "When did the next one start" and "when did this one end" are the same moment, so one timestamp is enough |
| `end` | `delivered` or `abandoned`. Without it, the history is a list of branches with no way to tell which ones actually shipped and which were dropped halfway |
| `mr` (optional) | the only one that is genuinely awkward to look up later: once the branch is deleted you need `glab mr list --source-branch` to find it, and if the branch had several MRs the answer is ambiguous. A URL is a fixed fact, so storing it does not break the storage rules ([§2](INDEX.md#2-storage-criteria)). An abandoned round may never have opened an MR at all, which is why the field is optional |

The field is `end: "delivered" | "abandoned"` rather than `"abandoned": true`, so it reads clearly without relying on a convention like "absent means delivered".

Three things are deliberately not stored: `why` (that is narrative, and it is in `log.md`), `base` (`git log` shows whether the new branch contains the old branch's commits), and `mode` for past rounds (nobody ever looks it up).

`yan` works out `end` on its own, without an extra flag. When the branch is being replaced, it checks the current `mr`'s state on GitLab:

| State on GitLab | Conclusion |
| --- | --- |
| merged | `delivered` |
| closed, or the `mr` field was empty to begin with | `abandoned` |
| still open | this round is not over. Ask `user` first: abandon it, or was this a mistake? |
| cannot be reached (offline, MR deleted) | ask `user` |

This follows the rule that changing state is looked up on GitLab rather than stored. But the conclusion has to be written into the history, and after that GitLab is never asked again — the history has to explain itself.

Starting a new round is one atomic operation: work out `end` → append the current `branch`, `target`, and `mr` to `history[]` together with `at` → overwrite the current fields → add a line to `log.md`.

**The log line for an abandoned round has to say why.** The reason for a normal rotation is obvious from context — it shipped, or feedback came in. The reason for abandoning something is the one that gets forgotten. Six months later, when you find `2.0.3` stopping dead in the history, you will not remember why it was dropped.

```
- 08-25  auth  abandoned 2.0.3 → 2.0.4 (based on 2.0.3; upstream proto changed its interface, so the MR on this line could not be reviewed)
```

`target` has no default value, and `yan unit add` requires it explicitly. The way `user` actually works, a big release means the team keeps one shared branch for a while and everyone merges into it, while quiet periods mean everyone merges into master. There is no safe default.

`needs` records the landing order, and `yan land` topologically sorts by it. The same repository may appear in several units: the sub-applications of the team's monorepo are worked on separately, and you cannot change two applications on the same branch. So one `unit` is one sub-application is one branch is one tree.

## 6.5 Who names branches

The integration branch's name may be delegated to an outside authority (okt). The shift branch's name always belongs to `yan`.

The reason is that okt understands the team's concepts — features, applications, releases — and knows nothing about a `shift`. Letting it name shift branches would be pointless, and actively harmful. Shift branch names must also not be derived from the integration branch's name, for example turning okt's `feature/AUTH-123` into `feature/AUTH-123/s1`. Three reasons:

1. Branch protection and naming checks may impose rules on the team's prefixes, and internal branches would run into them.
2. Colleagues looking at the branch list on GitLab would be flooded with internal branches.
3. okt may scan or manage the prefixes it recognises, and `yan`'s internal branches should not be visible to it.

There is also a hard limit in git itself: once `refs/heads/feature/AUTH-123` exists as a file, `feature/AUTH-123/s1` cannot be created at all (`cannot lock ref ... exists`).

```
integration branch   named by the hook; without a hook, defaults to yan/<task>-<unit>-r<n>
                     e.g. 2.0.2 (from okt)   or   yan/t042-auth-r2 (the built-in default)
shift branch         always named by yan, fixed format, never derived from the integration branch
                     yan/<task>-<unit>-<sid>        e.g. yan/t042-auth-s7
```

The built-in default has to carry the round number `r<n>`, because the integration branch gets replaced (§6.3). Without it, the second round would collide with the first, and the same branch name cannot be created twice.

`n` is the length of `history[]` plus one, so it needs no extra storage: the round number is just how many entries the history has. When a hook is present, whatever okt returns is used as is (`2.0.2` already carries version meaning), and the round number plays no part.

**Shift branches carry no round number.** `sid` increases globally (s1, s2, s3, …), so the second round's `s7` cannot collide with the first round's `s3`. And §6.6 establishes that `yan` never parses branch names and always looks ownership up in storage, so a shift branch name does not have to say which round it belongs to.

`yan/t042-auth-r2` and `yan/t042-auth-s7` are two file names at the same level and can never collide, so there is no need for a `/trunk`-style suffix.

## 6.6 `yan` never parses branch names

Because naming the integration branch may be taken over by okt, `yan` cannot assume the name has any structure. It does not infer ownership by globbing a prefix. Instead, `task.json` stores `unit.branch`, and `run/meta.json` stores the shift branch name. Asking the reverse question — "who does this branch belong to?" — means looking in storage, not splitting a string.

One exception: `git branch --list 'yan/*'` may be used to find every branch `yan` created, for maintenance cleanup. That is enumerating our own things, not inferring ownership from a name, so it does not break the rule.

## 6.7 How big a `unit` should be

When the integration branch merges into `target`, that MR's diff is the sum of every `shift`. Pile up enough shifts and colleagues cannot get through the review. That cost gives the size of a `unit` a clear standard:

> The size of a `unit` is the size of one outbound MR, which is how much a colleague can review in one sitting.

When it grows past what a review can absorb, it should have been split into two units — two integration branches, two outbound MRs.
