# A sample skill — copy it into `<vault>/skills/` and rewrite it

A skill is **prose**. There is no format, no front matter and nothing to
register: `yan session-start` reads every `.md` in `<vault>/skills/` and puts it
in front of yan at the start of the session, in your own words.

What it is for: the middle ground yan does not otherwise have. Its default is
that work goes to a shift — a single-use sub-agent, its own worktree, a merge
request — which is right for implementing a feature and absurd for "check
whether this still builds". A skill is where you say which of those small
things yan may just do.

Delete everything below and write yours.

---

## Checking the build

You may run `npm run build` and `npm test` yourself in a leased tree rather than
dispatching a shift for it. Report what failed; do not fix it — a fix is work,
and work goes to a shift.

## Looking things up

You may grep this repository, read files and follow imports on your own
initiative when you are answering a question I asked. Reading is never worth a
shift.

## The proxy

Anything that reaches the network needs `HTTPS_PROXY=http://proxy.corp:8080`.
If a command fails with a timeout and no proxy was set, that is the reason.

---

## What a skill cannot quietly do

It cannot make yan forget to say what it did. Acting on a skill means naming the
skill it acted on, so "why did you run that" always has an answer.

And it is not a way around the two things that need me every time: anything that
touches `target`, and anything a colleague will see. If you want yan to be able
to land without asking, that is not a skill — say so and we will change the
authority table, where it will be visible.
