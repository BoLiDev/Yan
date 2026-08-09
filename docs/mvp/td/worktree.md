# 7. Worktrees

**The pool is part of `yan`: `yan tree get | return | status`.** It is not a separate binary and it does not depend on any outside tool.

`user`'s own wtpool is not used, because it is an unreleased CLI that lives on another machine. treehouse is not wrapped either. The reason is not a preference for keeping zero state files; it is that the branch model does not match, and neither does the test for when a tree may be given back:

1. **Branch model.** treehouse always keeps a detached HEAD and treats "we never touch branch names" as a feature. But `yan`'s shift branches have to be cut from the integration branch, pushed, and turned into MRs ([§6.1](branching.md#61-branch-structure), [§6.5](branching.md#65-who-names-branches)), so the tree has to be on a real branch.
2. **The test for giving a tree back.** treehouse allows it once HEAD has been merged into the **default branch**. But `yan`'s shift branches merge into the integration branch, which is never the default branch. So every normal clock-out would be refused, and `--force` would have to be passed permanently — and [§9.2](boundaries.md#92-external-side-effects) lists `--force` as a forbidden action.

Turning a last-resort escape hatch into an everyday step is a cost I am not willing to pay.

To be fair about the zero-state argument: **it is the weakest of the three.** treehouse needs a state file because it has to express "no process is running but this tree is still taken", and that cannot be derived from anything, so it must be stored. `yan` needs both cases. While a `shift` is working there is always a live process in the tree, so scanning processes would be enough. But `yan sync` takes a short lease with no process behind it (see the isolation rule below: the integration branch does not permanently occupy a tree, it is leased briefly and returned), and during that window only a lease can express that the tree is taken. So zero state is not a reason to reject treehouse; it is just a difference in taste.

Building the pool in means the interface can be defined directly in terms of `yan`'s model, with no extra branch handling bolted on after the lease:

- **Branch-aware.** `yan tree get --base <integration branch> --branch <shift branch>` creates the shift branch as part of leasing the tree.
- **How a lease is attached.** The holder string is `<task>/<unit>/<sid>`. `yan tree status` shows who holds what, which makes the pool its own runtime registry.
- **Lease identity.** Every acquisition generates a random `lease_id` (copied from treehouse).
- **Conditional return.** `return --if-lease-id` and `--if-lease-holder` compare while holding the lock, and if it does not match they exit non-zero *before* doing anything destructive — no killing processes, no resetting, no clearing state. That makes automatic retries safe.
- **`--json` output.** `get` returns `{path, lease_id, holder}` and `status` returns an array.
- **Isolation.** One tree per `shift`. The integration branch does not permanently occupy a tree; `yan sync` leases one briefly and returns it.
- **How full the pool gets.** Occupancy equals the number of live shifts, and has nothing to do with the number of tasks.
- **Warm reuse.** Returning a tree means `reset --hard` plus `clean -fd`, never with `-x`. `-x` deletes gitignored files too, and that one letter is the difference between reusing a tree in seconds and reinstalling everything from cold each time.
- **Backpressure.** When the pool is full, `get` fails rather than creating another tree. This pairs with the previous point: if a full pool just grew, it would slowly get fatter, and every extra tree would be a cold one, which is the same as having no pool.

`lease_id` and conditional return are not optional extras. They solve the same class of problem the guard's identity check solves in [§5.5](supervision.md#55-supervision): if only the holder label is checked, a retried call, or one left over from an earlier round, could return a tree somebody else has just leased. The supervision layer already took stale identity seriously; the pool should not be left bare.

One more invariant belongs with the pool: **when spawning a sub-agent, assert that its working directory is not the main clone's path, and refuse to start otherwise.**

## The warm-reuse contract

If reuse were not needed, one `git worktree add` per `shift` and a `remove` at the end would do, and none of this — pool, leases, backpressure — would be necessary. **All of the extra complexity buys exactly one thing: on a large monorepo, three warm trees stay ready, and whichever one you lease needs no cold install.**

So this is a contract of `lib-pool`, not an implementation detail:

> **Returning a tree uses `git clean -fd`, never with `-x`.** Gitignored dependencies and build caches survive from one `shift` to the next.

An honest limit: this removes the *cold* install, not every install. When the lockfile changes between integration branches, the `node_modules` in a warm tree is out of date. The right way to handle that is to run the install every time in the brief. When the tree is warm it finishes in a couple of seconds with nothing to do; when the lockfile changed it does an incremental install. Do not try to be clever and skip the step.

Because of that, `yan` does **not** need treehouse's `post_create` provisioning hook. The brief already runs the install, so cold trees and warm trees take the same path and both are covered without an extra mechanism. Opening N new trees for the first time means N installs. That is a one-off cost; it is enough to know about it.

## Pool size

**It is configured per repository as `pool_size` in `repos.json` (default 8).** Field shape: [Appendix D](appendix.md#appendix-d-configuration). It is not a global constant.

This number directly sets the maximum number of concurrent shifts on one repository, independent of how many tasks exist (see "how full the pool gets" above). That makes it a real decision rather than an implementation detail.

It is a trade between disk space and parallelism. The default is 8 because a tool should not decide the ceiling on parallelism for `user` — a full pool is an accurate signal, and `user` will know when they hit it. There are two situations that call for a lower number, both on monorepos:

1. **Disk.** A single tree's `node_modules` can be several gigabytes, so eight of them can be tens of gigabytes.
2. **More trees means weaker warm reuse.** Each tree is used less often, so it is more likely to go cold after a lockfile change. A smaller pool is actually warmer, which is the opposite of the intuition that a few more trees can only help.

So setting it to 2 or 3 on a huge monorepo is entirely reasonable, and that is exactly why the setting has to follow the repository.

**One trap that follows from this:** `yan sync` also takes a short lease. If the pool is full, `sync` fails — and it happens to be the first step of `yan shift new`. This is not a deadlock, since a full pool means no new `shift` should be starting anyway. But the error message has to say "the pool is full, cannot start a new `shift`", not "sync failed", otherwise you go looking for a synchronisation problem that does not exist.

## When it is safe to return a tree

Returning a tree means `reset --hard` plus `clean -fd`, which destroys what is in it. So there is only one question to answer: would destroying this tree lose anything?

| Situation | Is there a copy outside the tree? |
| --- | --- |
| changed, not committed | ✗ returning the tree loses it permanently |
| committed, not pushed | ✗ this is what the orphan-commit guard is for |
| pushed, even with no MR opened yet | ✓ the copy is on the remote, which is enough |
| the shift branch is merged into the integration branch | ✓ this is the condition for clocking out |

"There is a copy" and "the work has landed" are two tests of different strength. The first governs whether a tree may be returned; the second governs whether a `task` may be declared finished. Folding both into one "landed" check fits systems whose workers live until the work lands. `yan` separates them, so returning a tree only needs the weaker test, and two commands answer it:

```sh
git -C "$tree" status --porcelain         # non-empty → uncommitted changes → no copy
git -C "$tree" branch -r --contains HEAD  # empty     → no remote branch contains HEAD → no copy
```

Fishing in `refs/pull/<n>/head` after a squash merge deleted the branch is not needed. That complexity belongs to the landing test.

`yan tree return --force` is forbidden unless `user` says explicitly that the changes can be thrown away. The orphan-commit guard is the last line of defence: the moment it refuses to return a tree is exactly the moment the work exists nowhere else. A refusal means stop and investigate, not add `--force` and move on.

## The order of operations when clocking out

> **MR merged → write `outcome.md` → `rm -rf run/` → return the tree → delete the remote shift branch → the `shift` ends**

Get the order wrong and a squash merge breaks the copy test above. If the internal MR was squash-merged, the integration branch does not contain the shift branch's HEAD. Deleting the remote shift branch first would make `branch -r --contains HEAD` empty, so the test would report "no copy" and refuse to return the tree — even though the work landed long ago.

Returning first and deleting second means the remote shift branch is still there when the tree is returned, so the copy test always passes; and the deletion happens last, by which time the work is in the integration branch. **This way `yan` does not have to care whether the team configured internal MRs to merge or to squash** — and in a work repository, that setting may not be ours to decide.
