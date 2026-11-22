---
name: handoff
description: Hand a matter over from Janus to a task of its own, with a handoff written for the agent that takes it up. Use it as Janus when the user says to make a task of what was discussed, or agrees when you say that something has grown into work of its own.
---

# handoff

What was looked into here has become work of its own: it gets a task, and the agent started on that task knows nothing of this conversation. The handoff is all it gets.

1. **Agree the scope** with the user first, in a few lines: what the task is to settle, what it leaves out, which repositories it works in (and in a monorepo which packages), and its title. Do not make the task before they agree.
2. **Write the handoff** as a file in your own folder, `artifacts/docs/handoff-<short-name>.md`. It becomes the new task's problem.md, so write it as that: the background, and what the problem is, for a reader who starts from nothing.
   - What the user wants and why, in their terms, and what was found here that bears on it: the facts, with where each was seen (a file and line, a command and what it printed, a link), not the story of how they were found.
   - What is settled and what is still open, said apart. A guess is marked as one.
   - No solution laid out as steps to follow: how things must be once it is solved is the deliverables', which that agent works out with the user (yan:define). Say what you would try, if anything, as a suggestion.
3. **Hand it over**: `yan handoff "<title>" --problem <the file> [--repo <name>[:<package>,...]]...`, with `--artifact <path>` for each file or folder of yours the task should carry (a recording, a data sample, a draft). It makes the task, puts the handoff in it as its problem.md, the artifacts in its artifacts/, and starts the task's agent in a terminal tab of its own, in the task's worktrees. That agent is not told to begin: it waits there for the user. `yan handoff --help` for the rest.
4. **Say what was made**: the task's id and title, and that its agent is waiting in its own tab. Then let go of it: the matter is the task's from here, and what you kept of it here is done with. Give back any worktree you took for it (`yan tree return`).

- A matter that is a question answered, or a small thing already done, needs no task. Say so when the user asks for one, and make it if they still want it.
- Never write in the new task's folder yourself, before or after: `yan handoff` puts there what it starts with, and from then on it is its agent's.
