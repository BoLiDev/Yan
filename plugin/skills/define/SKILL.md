---
name: define
description: Use when the user wants to define or clarify a task's problem, or add scope to a task, such as a new PRD, a fresh production issue, or a requirement that comes up midway. Works out the problem and the solution with the user before any code is written.
---

# define

Every task is **two questions**: what is the *problem*, and what is the *solution*. This skill answers both, with the user, **before any code is written**. It ends when both are agreed; implementation is a separate step the user starts.

## Problem

Start with the *obvious behaviour*: who sees what, where, and when. Then the *why*.

- **An incident or bug**: find the cause. Read the code, the logs and the history, and reproduce it if you can. Explain how the cause leads to what is seen, step by step, with no gaps. **Find the cause before you explain it**: if you could not confirm a step, *say so plainly* instead of making it sound certain.
- **A PRD or feature**: there is usually no root cause, but there is a **background**. Explain how the people involved work today, why what exists doesn't fit that, and what is being asked for. For example: an admin page is awkward because staff handle requests in batches and the page only takes them one at a time, so this change adds bulk actions.

## Solution

The high-level solution, **not a technical design**. Say what will change and what things will look like afterwards, as *one connected thought*, and why that addresses the cause. If there was a real choice between approaches, say in one line each why the others lost.

Leave out file lists, function signatures, data shapes and step-by-step plans. Agents handle the implementation; this skill is for knowing exactly what to build and why.

Example: the page loads slowly because a meta tag stops Chrome's preload scanner, so the scripts download only once parsing reaches them, not alongside the HTML. The solution is to get the same effect some other way that leaves the scanner running, so the scripts download in parallel again.

## How to explain

Explain the way you would explain it to a colleague at a **whiteboard**. Talk about behaviour and mechanism: what the system does, what it waits on, what it gets wrong. **Don't explain it through implementation details.** "`useFoo` calls `resolveBar` with a stale `ctx`" is *a pointer, not an explanation*. Say what actually happens ("the page reuses settings from the previous user"), and put the code reference after it as evidence.

Sometimes code shows the problem better than prose can. When it does, show the code: a **complete**, **readable** excerpt from the source, or a few excerpts placed together, with a sentence on what to look at. Show the code as a block or don't show it at all, <u>never as identifiers scattered through a sentence</u>.

When the problem is *mostly visual* (a layout that breaks, an interaction that misbehaves), a screenshot or GIF says it better than a paragraph. Capture one if you have a browser or screenshot tool, or ask the user for one, and show it next to the explanation.

## Pacing

There are two checkpoints: confirm the problem with the user, then the solution. **Never start the solution on a problem the user hasn't agreed to.**

- **A simple problem**: present it, confirm it, and move on. Don't manufacture questions.
- **A complex problem**: start with a short summary of what you understand so far. Then take the open questions **one at a time**, most consequential first, and wait for each answer before you ask the next. <u>Never send a list of questions in one message.</u>

## Recording

Communicate in **the user's language**. Everything written down is in **English**.

When the task is run through `yan` (`$YAN_TASK` is set), once each part is agreed:

- the problem goes in `problem.md` (`yan context` shows where it is), written as prose
- the solution goes in `yan deliverable add`, one statement per change the user asks for, saying what changes and what it achieves together; the parts of one change go inside its statement, not into deliverables of their own
- the choice made, and why, goes in `yan log agreed "<line>"`
- the PRD, tickets, dashboards and other links go in `yan resource add`

Without `yan`, end with the agreed problem and solution written out in the conversation.
