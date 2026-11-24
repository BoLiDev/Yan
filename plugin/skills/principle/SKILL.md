---
name: principle
description: Record one of the user's principles for the current yan task, a standing requirement the whole task is held to, when the user runs it with what the principle is.
disable-model-invocation: true
---

# principle

A task's principles are the user's standing requirements for it: what holds through the whole task whatever is being worked on, as a CLAUDE.md holds for a repository. They are kept in principles.md in the task's folder, which `yan context` names. Every session on the task is given them as it starts, and `yan context` prints them.

Most tasks have none, and the file is not there until the first one is recorded. They are the user's alone: one is recorded only here, when the user runs this with what it is, and never because a session thought one would help. Working out the problem and the solution (`yan:define`) leaves them as they are.

1. **Take what the user said** after the command as the principle. With nothing said, ask what it is, and write nothing until they say.
2. **Write it** in principles.md, in the task's folder, making the file when there is none: a short list, each principle a line or two in the user's own terms, stated as how the work must be and not as a story of why it came up. One that restates, sharpens or reverses one already there replaces it; one the user takes back is removed, and the file with the last of them. Change nothing else in it.
3. **Show the list** as it now stands, and say in a line what changed.
4. **Hold to it from now on**, in this session too: it applies at once, not from the next start. When something already done goes against it, say what, and ask before changing it.

- Write nothing of it elsewhere: not in problem.md, the deliverables or the log.
- A principle that contradicts the problem or a deliverable is said to the user, who decides which gives way.
