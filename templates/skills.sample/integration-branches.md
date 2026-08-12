---
name: Integration branches
description: Branches here come from the ticket system rather than from yan: run the team tool, then hand the name it prints to --branch.
---

# Integration branches

Branches here come from the ticket system rather than from yan: run the team's
tool, then hand the name it prints to `--branch`.

The `name` and `description` at the top are the only part `yan session-start`
carries into the session. Everything below is read when it turns out to matter,
so write that description as what it is: the sentence that decides whether this
file gets opened.

---

## The flow

Before adding a unit or starting a new round:

1. run `ticket-cli branch --for <ticket>`; it opens the branch on the forge and
   prints the name
2. pass that name straight through: `yan unit add … --branch <the name>`, or
   `yan unit set --task … --unit … --branch <the name>` for a new round

If `ticket-cli` refuses, **stop and tell me**. Do not fall back to the built-in
`yan/...` name — a branch this team's tooling has just declined is one that will
not be mergeable, and inventing one quietly turns a clear refusal into a
confusing merge request three days later.

`--branch` takes `refs/heads/x`, `origin/x` and a quoted name as readily as `x`,
so pasting whatever the tool printed is fine. yan adopts a branch that already
exists and cuts one that does not, so it does not matter which of you got there
first.

## Release periods

While a `release/*` branch is open, integration branches are cut from it rather
than from `master`, and they are named `hotfix/<unit>`. Ask me which is current
if the task does not say — I would rather answer that than find out later.

---

## Leaving this out is a real answer

With no skill about branches, yan names the integration branch
`yan/<task>-<unit>-r<n>` and cuts it from the target itself. That default is
fine for anything without a house rule, and it is what a personal project should
use.

This replaced a `branch-create` hook — an executable with a JSON contract, an
exit-code protocol and an interpreter table — because the process it encoded
turned out to be two sentences, and the machinery around them was bigger than
they were.

## What this cannot do

It cannot authorise landing. `yan land` needs me every time, release period or
not, and no wording in a skill changes that: that decision lives in the
authority table where it is visible.
