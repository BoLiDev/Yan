# Yan

Yan is a personal harness for agent sessions. These are the words of its work model as settled for v2: what a piece of work holds, and how it gets from where it is to where it is going.

## Language

### The work

**Task**:
The one unit of work: one thing the user wants changed, from first idea to closed. It holds a **Path**, its **Materials**, its **Links** and its worktrees.
_Avoid_: Project, ticket, issue

**Path**:
The graph of **Steps** that carries a **Task** from where it started to its **Destination**, always current. Every task has exactly one; it is a plain chain when the work is simple.
_Avoid_: Map, plan, line, roadmap

**Destination**:
The few lines on a **Path** saying what will be true when the **Task** is done, with its **Outcomes** listed beneath. It is rewritten in place when the goal moves.
_Avoid_: Problem, goal, brief

**Outcome**:
One checkable thing on the **Destination** that the user accepts the **Task** against. Only the user marks it met.
_Avoid_: Deliverable, acceptance criterion, requirement

### Steps

**Step**:
One node of a **Path**: a piece of work of one kind (decision, research, prototype, spec or build) that is to do, done or dropped. A step relies on the earlier steps whose **Results** it was built from. A step still to do is ready when every step it relies on is done, and waiting otherwise.
_Avoid_: Node, ticket, stage, phase, blocked

**Slice**:
The share of a **Spec** that one build **Step** makes work: a piece of behaviour that runs end to end, so the user can see it working when the step is done.
_Avoid_: Ticket, layer, chunk

**Dropped**:
The state of a **Step** that no longer holds, whether or not it had been done. A dropped step stays on the **Path** with the reason it was dropped, and is never taken up again: work that returns to it is a new step.
_Avoid_: Deleted, cancelled, abandoned, invalid

**Change**:
Something that makes the **Destination**, or the **Result** of a done **Step**, stop holding. It is recorded once on the **Path**, and the steps dropped or added because of it point to it. A path that only gains, reshapes or drops steps still to do has not changed in this sense.
_Avoid_: Pivot, revision, amendment

**Re-route**:
The edit to a **Path** that answers a **Change**: the destination rewritten if it moved, the steps the change reaches **Dropped**, new steps added. The agent proposes it whole and the user decides.
_Avoid_: Replan, rebase, reset

**Result**:
What a finished **Step** concluded: a decision's answer and why, a finding, a prototype's verdict, a **Spec**, or what a build made work.
_Avoid_: Outcome, resolution, answer

### What work leaves behind

**Material**:
Any file a **Task** keeps outside the code: a **Spec**, a **Prototype**, research findings, a report, a script. A change to code is a commit, not a material.
_Avoid_: Artifact, document, deliverable, resource

**Spec**:
The brief for building: a **Material** written by a spec **Step** that gathers the **Results** before it so that a builder with no memory of them can work from it. It is not edited once its step is done; a revision is a new spec step.
_Avoid_: PRD, plan, design doc

**Prototype**:
A rough **Material** made to be reacted to, belonging to the **Step** that asked for it.
_Avoid_: Mock, spike, demo

**Link**:
A URL a **Task** keeps with a label, pointing at something that lives outside Yan: a pull request, a pipeline, a deployed environment. Yan stores it and never reads what is behind it.
_Avoid_: Resource, reference

**Review**:
The user's comments on selections of what a **Task** holds (a **Material**, a diff, a **Prototype**), gathered into one file and handed to the agent. It is never edited once written.
_Avoid_: Feedback, annotation

**Companion**:
The private folder that goes with one repository, one to one, holding what outlives any **Task** there and is not committed to that repository: its glossary, its decision records, the user's own documents and scripts.
_Avoid_: Shelf, sidecar, shadow, repo notes

### Beside the work

**Draft**:
A note of the user's own, kept in the vault and belonging to no **Task**. Agents read drafts and never write one.
_Avoid_: Note, memo, idea

**Janus**:
The standing general-purpose agent that belongs to no **Task**, one per machine: asked anything, and free to act on the machine at large. It reads tasks and repositories without changing them, and work that turns out to be a task leaves it by a **Handoff**.
_Avoid_: Assistant, general agent, inbox

**Handoff**:
**Janus** making a **Task** out of a conversation: it writes the task's **Destination** and starts that task's agent.
_Avoid_: Transfer, escalation
