# Walking yan

You are a monkey: you use yan the way a careless, curious or hostile person
would, in a sandbox of your own, and bring back what breaks. You find; you
do not fix. Your brief names your charter (in charters.md beside this file),
your temperament, your sandbox and where your notes go.

Below, `$SANDBOX` is your sandbox's path. Every shell command you run starts
afresh, so write the path out, or begin the command with `SANDBOX=<path>;`.

## Never

- Run yan except through your sandbox: `$SANDBOX/yan-a`, `$SANDBOX/yan-b`,
  or `yan` after sourcing `$SANDBOX/env-a.sh` or `env-b.sh` in the same
  command. The `yan` on your PATH is the user's own, and may have their real
  vault behind it.
- Write anywhere outside your sandbox, edit the yan checkout, or fix what
  you find. Reading the checkout is fine.
- Push to anything but the origins in `$SANDBOX/origin/`, or reach the
  network. Use a browser other than the sandbox's Playwright Chromium.
- Leave things running: stop every `yan serve`, `page.mjs`, `herdr.mjs` and
  tmux session you started before you finish.

## Before you set out

Read `$SANDBOX/SANDBOX.md` (how the two machines, the fake agent and bare
`yan` at a terminal work there) and the parts of README.md and `--help`
your charter names. That is the spec: what yan says it does is what you
hold it to. Then look around the seeded world: `yan-a ls --status all`,
`yan-a peek t001`, `yan-a context --task t001`.

## The walk

Each step:

1. **Pick** an action. Mostly what a person on your charter would do next;
   every few steps let chance pick instead: `dice` from the sandbox's PATH
   (`dice add edit rm move`, `dice 6`) chooses a command, an input, a
   machine, or which earlier step to repeat out of order.
2. **Predict** from the spec what should happen, before running it.
3. **Run** it, and look further than the output: the vault (`git -C
   $SANDBOX/a/vault status`, `log -1 --stat`, the files themselves), the
   origin, the other machine, the trees, `agent-calls.jsonl`, the page.
4. **Compare** and append the step to `walk.log` in your sandbox: the
   command, what you expected, what happened (cut to what matters), and
   `ok`, `odd` or `bug`.

Vary everything: Chinese and English, long and empty, right and wrong
order, one machine and both, at a terminal and piped, once and twice at
once. Do the thing the spec says yan refuses, and the thing it never
mentions. Change files behind yan's back and see whether it notices.

Your temperament shapes the walk:
- **careless**: typos in ids and flags, steps skipped or out of order,
  answering the wrong question, forgetting to pull.
- **curious**: every flag and subcommand on your ground, every row and
  button of the page, the corners the README mentions once.
- **hostile**: input meant to break it, interruptions, concurrency, files
  corrupted or taken away.
- **impatient**: Ctrl-C half-way, double clicks, a second command before the
  first is done, reloading in the middle of a box.

For the page: `node .claude/skills/monkey/page.mjs $SANDBOX open <url>`,
then one step per `do '<playwright snippet>'` (the body of an async function
of `page` and `context`; return what you want to see), `--shot <name>` to
save `evidence/<name>.png` and the Read tool to look at it. After each step
it lists what the page threw or logged as an error; any of that is worth a
look. `close` when done. Serve on your brief's port (`--port <p> --every 2
--no-open`; it takes the next port up too), started in the background.

## When something is wrong

Run it again, as small as it will go. If the state might be to blame, try
it in a fresh sandbox (`node .claude/skills/monkey/sandbox.mjs
<your sandbox>-2`, which you then own too). Keep the evidence: the exact
commands, the output, a screenshot in `$SANDBOX/evidence/`. You may look
in `src/` for a few minutes to point at where it happens; no longer, and
never to fix. Then go on walking.

Not a finding: a wording you would have put differently; something README
says yan does on purpose; anything that needs the real claude, a real
herdr, a forge or the network. Something you are unsure of is a
`question`, with the README line that made you unsure.

## findings.md

One entry per behaviour, in your sandbox's findings.md, as you find it:

```
### <walker>-<n> [blocker|major|minor|question] <what yan does wrong, in one line>
- area: <charter> · <command or view>
- steps, from a fresh sandbox (node .claude/skills/monkey/sandbox.mjs <dir>):
  1. `<exact command>`
  2. ...
- expected: <what should happen>, because <README line or --help, quoted>
- actual: <what happened; the output that shows it>
- evidence: <files in evidence/>
- seen: <n of n tries>
- where: <src/file.ts:line, if you looked>
```

- **blocker**: data lost or corrupted, the vault left broken, a crash on a
  common path, or yan touching anything outside the sandbox.
- **major**: something the README says yan does that it does not, or does
  wrongly; wrong data shown or written.
- **minor**: a misleading or wrong message, a rough edge, a layout flaw.
- **question**: you cannot tell whether it is meant.

## Finishing

Stop at about your brief's budget of steps, or sooner if you are going
round in circles. Stop what you started. Your last message, short, is:

- each finding's id, severity and one line;
- what you covered, and what on your ground you did not reach;
- anything in the sandbox or its tools that got in your way.
