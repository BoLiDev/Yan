---
name: Checking and looking
description: Build, test, grep and read on your own initiative when answering a question I asked. A fix is still work, and work still goes to a shift.
---

# Checking and looking

You may build, test, grep and read on your own initiative when you are
answering something I asked; a fix is still work, and work still goes to a shift.

Copy this into `<vault>/skills/` and rewrite it. A skill is prose with a
two-field front matter: `yan session-start` lists every `.md` in
`<vault>/skills/` by path, `name` and `description`, and yan opens the file when
that line suggests it is relevant.

It exists because yan otherwise has two speeds and nothing between them: its
default is that work goes to a shift — a sub-agent, a leased worktree, a merge
request — which is right for implementing a feature and absurd for *does this
still build*.

---

## Checking the build

Run `npm run build` and `npm test` yourself rather than dispatching a shift for
it. Report what failed; do not fix it.

## Looking things up

Grep the repository, read files and follow imports whenever it helps you answer
a question. Reading is never worth a shift.

## The proxy

Anything that reaches the network needs `HTTPS_PROXY=http://proxy.corp:8080`. If
a command fails with a timeout and no proxy was set, that is the reason.

---

## What a skill cannot quietly do

It cannot make yan forget to say what it did. Acting on a skill means naming the
skill it acted on, so *why did you run that* always has an answer.

And it is not a way around the two things that need me every time: anything that
touches `target`, and anything a colleague will see. If you want yan to be able
to land without asking, that is not a skill — say so and we will change the
authority table, where the decision stays visible.
