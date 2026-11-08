---
name: monkey
description: Monkey-test yan by sending subagents to walk it, each in a sandbox of its own (two machines sharing a vault, a fake claude, yan serve's page in Chromium), using it as a careless, curious or hostile person would, then verifying and reporting what breaks. Use when the user asks for a monkey test, a walkthrough or 走查 of yan, exploratory or chaos testing, or types /monkey. You only orchestrate; every walk is a subagent's.
argument-hint: "[launch|agent|sync|serve|abuse ...] [--walkers N] [--steps N] [--since <ref>] [focus in words]"
---

# monkey

Subagents walk yan; you never do. You build, make the sandboxes, brief the
walkers, have their findings verified, and write the report. Do not run yan
to look for bugs, open its page, or reproduce a finding yourself, not even
"just to check one": send a subagent. A walk you did would be anchored on
what you already think, which is the thing this is for getting away from.

Beside this file: `charters.md` (the ground each walker covers),
`walker.md` (the walkers' rules, which they read themselves),
`sandbox.mjs`, `page.mjs` and `herdr.mjs` (their tools).

## 1. What to walk

From the arguments:

- **Charters** by name (`launch`, `agent`, `sync`, `serve`, `abuse`): those.
  None named: all five.
- **Words** that are not a charter: a focus. Add it to the chosen charters'
  briefs, or, when it names ground none of them covers, write a charter for
  it in the shape of charters.md and walk that alone.
- **`--since <ref>`**: what changed. `git log --oneline <ref>..HEAD` and
  `git diff --stat <ref>`; tell every walker those commits and files, to
  spend half its steps where they reach. Name the change, never a guess
  about what is broken in it.
- **`--walkers N`**: N walkers. More than charters: the extras walk a charter
  again in another temperament. Fewer: the first N of serve, launch, agent,
  sync, abuse.
- **`--steps N`**: each walker's budget, 40 by default.

Temperaments go round careless, curious, hostile, impatient, so walkers on
the same charter differ.

## 2. Prepare

1. The run's folder: `<scratchpad>/yan-monkey/<YYYYMMDD-HHMM>/` when the
   session has a scratchpad directory, else `${TMPDIR:-/tmp}/yan-monkey/...`.
   It must not be inside a git work tree.
2. The build: the sandboxes copy `dist/` and refuse one older than the
   source. If one says so, `npm run build`, once.
3. One sandbox per walker, `w1`, `w2`, ...:
   `node .claude/skills/monkey/sandbox.mjs <run>/w<N>`. They take a few
   seconds each; build them in one command. A sandbox that cannot be made
   is printed with the step and yan's output: that is a finding of its own.
   Put it in the report, and if every sandbox fails the same way, stop and
   tell the user rather than walk a broken world.
4. A port for each walker's `yan serve`: 21000 + 10 × N.

## 3. Send the walkers

All in one message, so they walk at once, as `general-purpose` subagents in
the background. Each brief:

```
You are walker w<N>, monkey-testing yan, a CLI and web page whose checkout
is <repo root>. First read <repo root>/.claude/skills/monkey/walker.md and
follow it: it is your rules. Then the <charter> charter in charters.md
beside it.

Charter: <name>. <focus, and with --since the commits and files changed>
Temperament: <temperament>
Sandbox: <run>/w<N> (yours alone; read its SANDBOX.md)
Port for yan serve: <port>
Budget: about <steps> steps.

Notes go in <run>/w<N>/walk.log and <run>/w<N>/findings.md. Finding ids are
w<N>-1, w<N>-2, ... Your last message: your findings (id, severity, one
line each), what you covered and what you did not reach, and anything in
the sandbox that got in your way.
```

Give no hypotheses and no bugs you know of. Then wait: each one's result
comes back as a notification. While they walk, answer the user, nothing
more.

## 4. Verify

When every walker is back, list the findings by their headings
(`grep -h '^### ' <run>/w*/findings.md`), which is all you need of them:
the verifiers read the entries themselves. Merge headings that are one
behaviour seen more than once, keeping every id. Then send verifiers, in
the background, one per 12 findings, each a group that belongs together
(the page's, the vault's across machines, one command family's), with its
own ports and fresh sandboxes (`<run>/v<N>-<k>`):

```
You are verifier v<N> of a monkey test of yan, whose checkout is <repo
root>. Read <repo root>/.claude/skills/monkey/walker.md for the sandbox
rules ("Never" holds for you too); you are not walking, you are checking
findings that other agents wrote. Run folder: <run> (below, RUN). The
findings are in RUN/w<k>/findings.md, each with its steps; their evidence
is in RUN/w<k>/evidence/. Yours are these ids; ids on one line are one
behaviour reported more than once, verified once:

- <id>
- <id> = <id>

For each: build a fresh sandbox (node <repo root>/.claude/skills/monkey/
sandbox.mjs RUN/v<N>-<k>; findings that cannot disturb each other may
share one), follow its steps exactly, and say:
- reproduced, reproduced differently (say how), or not reproduced (say
  what happened instead);
- whether README.md or --help says this is what yan should do, quoting
  the line either way;
- the severity you would give it, by walker.md's scale.

Ports for yan serve: <from> to <to>. Fix nothing. Stop everything you
start. Write RUN/v<N>/verdicts.md, one section per id: verdict, the spec
line, severity, what you saw, evidence paths. Your last message: the
verdicts, one line each.
```

## 5. Report

Write `<run>/report.md`, in the user's language:

- **Header**: the date, `git rev-parse --short HEAD`, the walkers (charter,
  temperament, steps taken), the run folder.
- **Findings**, reproduced ones only, blocker first: id, one line, area,
  severity, the steps, expected against actual, evidence paths.
- **Not reproduced, or as designed**: one line each, with why.
- **Questions**: for the user to decide.
- **Coverage**: what the walkers reached, from their last messages and
  walk.log, and what nobody did.

Then stop anything the run left behind (`pgrep -fa "<run>"`; kill those
processes, `page.mjs ... close` first where it applies), leave the
sandboxes in place for the findings' evidence, and tell the user: the
findings by severity in a few lines, the report's path, and that nothing
was fixed. Offer to fix the confirmed ones, each with a test as AGENTS.md
asks, or another round on what nobody reached.
