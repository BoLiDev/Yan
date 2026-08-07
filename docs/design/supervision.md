# 5.5 Supervision

The supervision machinery copies firstmate's three hooks exactly, all registered in `.claude/settings.json`. What it does not copy is firstmate's separate triage layer.

| Hook | Type | What it does |
| --- | --- | --- |
| SessionStart | nudge | injects one instruction: run `yan session-start` first |
| Stop (autoarm) | `asyncRewake: true`, long timeout | take the single-flight lock → run `yan wait` in its own foreground → turn the result into exit 0 or exit 2 |
| Stop (turnend guard) | blocking | if supervision is not healthy, block the end of the turn; give up after a bounded number of tries and fail open |

autoarm's job is to start supervision. The guard's job is to check that supervision actually started.

`yan wait` is the watcher itself. autoarm starts it in the foreground, and the model never calls it — which is why "the model forgot to start supervision" is not a possible failure. Its output contract is written for the hook to read (an exit code plus one line of reason), not as stdout for the model: if something happened, it writes a wake file, prints the reason, and exits 0; if nothing happened, it exits non-zero silently. It is also a pure observer and holds no state, so a timeout, a kill, or dying along with the hook's process tree loses nothing — the `shift` is still in its own terminal and all the state is in files. This is what "a restart is a non-event" looks like at the supervision layer.

SessionStart is what makes a restart pick up where things stand. That ability comes from durable state plus a full rebuild at startup ([§5.1](agents.md#51-lifetime-tiers)), not from any hook. In firstmate's words:

> A restart must be a non-event because durable state and live backend inventory, not conversation memory, are authoritative.

The hook only removes the dependency on the model remembering to do it: at startup it injects an instruction to rebuild first. This is exactly what firstmate does (`FIRSTMATE_OP: v1 session-start: Run bin/fm-session-start.sh now, exactly once, before executing any other instructions`).

## The full flow

```
user speaks → yan finishes → yan is about to end the turn
   ↓  both Stop hooks fire on the same event, concurrently

   guard (blocking)                  autoarm (asyncRewake, long timeout)
   ─────────────────             ──────────────────────────────────
   is there work to supervise?        is there work to supervise?
     no → let it through                no → exit
   is the watcher healthy?             take the single-flight lock
     yes → reset the count,            run yan wait in its own foreground
           let it through                ↓ blocks for minutes to hours
   wait 800ms: was the lock taken?    the watcher sees s1 finish
     yes → let it through                ↓ write the wake file
   neither → count + 1                 exit 2 + a banner on stderr
     ≤3 → exit 2, block, and the        ↓
          model goes and fixes it     yan is woken → yan drain
     >3 → let it through + warn       →  "s1 is done, MR ..."
```

Where the 800 ms comes from: both hooks fire on the same Stop event, so they are racing. The guard will often reach its check before autoarm does, and at that moment autoarm has not taken the lock yet and the watcher is not up yet. It looks like nobody is on duty, when in fact someone is walking through the door. So the guard waits a moment (firstmate uses `FM_CLAUDE_AUTOARM_SYNC_WAIT_MS`, default 800 ms) to give autoarm a chance to claim the lock. Without that wait, the guard would report a false alarm at the end of every normal turn.

The "three tries" budget belongs to the model, not to the guard. The guard does not start a watcher itself. It exits 2, which blocks the turn, and the model has to go and investigate: read the log, check whether the terminal is still there, arm the watcher by hand, and then try to end the turn again. So three tries means three chances for the model to intervene.

## Infrastructure

|  | Why it exists |
| --- | --- |
| single-flight lock | Claude does not deduplicate async hooks; every Stop fires one. Without a lock you would end up with several watchers |
| wake file | the reason for waking has to survive from "the watcher exits" to "the model's next turn". One line in an exit-2 banner is not enough. In firstmate's words: *The durable wake queue preserves actionable events between a rewake and the next Stop-launched arm* |
| beacon | `yan wait` touches a timestamp file on every loop, because a live pid does not prove the watcher is doing anything |

So "the watcher is healthy" does not mean "the process exists". It means three things at once: the lock file exists and the pid inside it is alive; the identity matches, so that pid really is our watcher and not some unrelated process that reused the number; and the beacon is fresh (300 seconds by default). firstmate blocks in both directions: *A stale beacon blocks even when a watcher pid is live; A fresh leftover beacon blocks when the lock is missing, dead, or identity-mismatched.*

autoarm's shape matters: `asyncRewake: true` plus a very long timeout (firstmate uses `timeout: 28800`, eight hours) so the hook itself can live for hours. The watcher runs in the hook's foreground, never backgrounded with a shell `&`, so the harness owns the process group and both die together on a timeout or when the session is destroyed. The timeout has to be long, because when the hook is killed the watcher goes with it.

## Design points for the guard

**One: its value shows up when autoarm never ran at all.** If autoarm ran and failed, it leaves a record of the failure behind. But if it was never invoked — `.claude/settings.json` got broken, the hook path is wrong, the harness skipped it — there is no record at all, not even a failure. That state looks exactly like everything being fine. The guard is the only way to detect it.

> This is why it has to be a second, separate hook. A hook that did not run cannot report that it did not run.

**Two: `stop_hook_active` cannot be used to prevent a deadlock.** Most harnesses rely on it. It means "this stop came immediately after a hook blocked the previous one", so reading true and letting the turn through guarantees each turn is blocked at most once. Under Claude that is wrong. From firstmate's `docs/turnend-guard.md`:

> *Claude Code sets `stop_hook_active=true` on every stop after any stop-hook continuation, including `asyncRewake` rewakes, which re-opened the 2026-07-21 blind window under the default one-shot behavior.*

The root cause is that two unrelated things share one flag. When the guard blocks, the flag means "I just blocked you, do not block again", and that calls for a counter. When autoarm rewakes, it means "something happened, wake up", which has nothing to do with preventing deadlocks. On the turn that autoarm woke, the very first stop already carries true — but it should have been false, because the guard never blocked that turn. So the guard lets it through, and that is precisely the turn that needed a new watcher started at its end. That is the blind window. It is a real injury, not a theoretical risk.

So the guard keeps its own count. The count is written to `run/guard-failures` and reset when the watcher becomes healthy again, and autoarm's rewakes cannot touch it. Two things fall out of that:

- The guard does not need to read the hook's stdin at all. Everything it needs — whether there is work, whether the watcher is healthy, how many times it has blocked, which `task` this is — is in the file system and the `YAN_TASK` environment variable. So it does not depend on `jq`, and it does not need firstmate's two fail-open branches for "jq is not installed" and "stdin was empty". It is easy to test, and a harness changing its payload cannot quietly break it.
- The semantics fit better. `stop_hook_active` means "block once per turn, forever". Counting yourself means "block three times during the whole outage, then warn clearly and stop". autoarm's rewakes create new turns often, so the first behaviour would be both noisy and useless.

The budget is 3, which stays under Claude's own limit of 8 (from the comment in `fm-turnend-guard.sh`: *below Claude's 8-block override*). That way we decide when to give up and print a warning that means something, instead of the harness silently forcing the turn through.

**Three: once the budget is used up, it must fail open.** Failing open does not mean giving up on the problem. It means going blind on purpose and saying so loudly. The `shift` keeps working as before, and its events are still appended to `run/status`, so nothing is lost. What is missing is anyone watching: when the work finishes, nobody will say so. That is why the turn that finally goes through has to print a clear message — automatic supervision is broken, from here on `user` has to check manually. At that point the options are to run `yan ls` and look, or to restart `yan`, which rebuilds at SessionStart and often fixes the problem on the way.

Why it cannot block forever: blocking forever means the whole session is unusable, `user` cannot get a word in, and every loop is a full model inference burning tokens. Going blind means finding out late. Being wedged means not being able to work at all. The first is acceptable.

## The sources `yan wait` watches

Watching the signal file alone is not enough, because an agent can die, get stuck, or forget to report — and one stuck `shift` would leave `user` waiting until the timeout. These three sources come straight from firstmate's experience:

| Source | What it catches | Cost |
| --- | --- | --- |
| `run/signal` | the `shift` reporting on its own | a file existence check |
| `term_agent_alive` | the agent died, which it cannot possibly report itself | one terminal query |
| the pane's content hash not changing for a long time | the agent stopped without reporting: stuck, waiting on a confirmation dialog, or it forgot | `term_read` plus `md5` |

The third one earns its place, because forgetting to report is the most common way an agent fails, and its cost is right there in the table: one `term_read` and one `md5`. `yan` does not need firstmate's fourth source, polling pull requests, because a `shift` does not wait for CI before clocking out ([§5.3](agents.md#53-the-life-of-a-shift)).

## Rules for an interrupting wake

When a hook wakes the model with exit 2, `user` may be in the middle of talking to `yan` about something else, and the notification from the `shift` will cut into that conversation. That is the behaviour we want, but `AGENTS.md` has to carry one rule:

> When a notification from a `shift` arrives, handle it first, then return to what `user` was talking about. Do not drop it or postpone it because another topic is in progress.

Without that rule you get failures like: a `shift` reported `blocked`, but `yan` was discussing an approach at the time and simply forgot.

One extra benefit of the per-task design: since a `yan` only handles one task, "something else" is usually still inside that task, so an interrupting wake stays on topic. A global main agent, as in firstmate, will interrupt a conversation about t051 with a blocked report from t042, and that really is jarring.

## Cost, gaps, and what was cut

**A task that runs for hours does not cost extra tokens.** A single run of `yan wait` is bounded (30 minutes and up), so a three-hour `shift` produces about six quiet exits. A quiet exit makes the hook exit 0 rather than 2, and the model is never woken. Coverage is unbounded even though each process is bounded, because the hook fires again on every Stop. But if the model never takes another turn, the hook never fires again — which is why a single run has to be long enough, and why the guard checks that the beacon is fresh. That check is the only way to detect autoarm failing silently.

There is one gap we accept knowingly. After every `shift` has clocked out and the outbound MR's CI is running, no agent is working and none of the three sources has anything to wait for. The answer for the first version is that `yan` ends the turn without waiting for CI, and the outcome is picked up the next time `user` starts `yan`, when the startup rebuild asks GitLab. The cost is that a red CI run does not notify `user` on its own. Getting that notification means adding a fourth source that polls GitLab — the machinery already exists, and it is scheduled for the version after the first.

What was cut: firstmate's twenty files are not spent on the pipeline. The pipeline is just the three hooks above. They are spent on a separate triage layer — absorbing harmless wakes, a "provably working" test, a wedge timer, an escalation counter, a demand-deep-inspection flag, an upper bound on busy turns. In `yan`, triage is exactly the three sources, and it lives inside `yan wait` rather than in a layer of its own. It can be this thin because none of the things that made firstmate's version grow apply here: busy-detection across several backends, run-step attribution for no-mistakes, conflicts between several home directories, procevent, X-mode.

Also cut: primary-scope detection (checking a marker, comparing the git dir against the git common dir — with one `yan` per `task` there is no agent tree), a separate adaptation for each of six harnesses (there is only Claude, [§5.6](agents.md#56-harness-requirements)), and hook payload parsing (stdin is never read).

Both hooks are small, and the guard is the smaller of the two.
