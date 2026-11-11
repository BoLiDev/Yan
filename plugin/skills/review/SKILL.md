---
name: review
description: Read the user's last review of the current yan task and act on every comment in it, when the user says they reviewed, left comments or feedback, or asks you to handle their review.
---

# review

The user reads what the task produced on yan's page, its documents and its branches, and says what they think as they go: a comment on a passage or on some lines of a diff, and a word on it all at the end. Together they are a review, a file in the task's reviews/ folder. It says everything the user means to say: do not ask them to repeat it.

1. **Read it**: `yan review` prints the newest, the word on it all first, then each comment, numbered, under where it is (a file of the task and its line; a branch, a file and its lines; or a page of the task and the CSS selector of the element in it) with what the user had selected, or for an element picked whole, what it says. Open the place itself for what is around it; where the file or the branch has changed since, find the passage by what was selected.
2. **Act on each comment.** One about a document changes the document; one about code changes the code in the task's worktree, on the branch it names, committed and pushed as the rest of the task's work is. A question is answered, not acted on. When a comment changes what the problem or the solution is, that is `yan:define`'s to settle with the user first. Where you disagree, or a comment can be read two ways, say so and leave it rather than guess.
3. **Answer by number**, in the user's language: for each comment, in a line, what you did, where, or why not. Leave nothing out.

- **Leave the review as it is.** It is the user's; nothing in reviews/ is written, changed or removed by you. Their next one is another file.
- **Leave the deliverables alone**, unless a comment says to change them.
- When the work under review was verified with `yan:uat` and a comment changed what it shows, gather that again.
