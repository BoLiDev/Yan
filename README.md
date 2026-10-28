# `yan`

Notes that outlive an agent session. We think about a task in three parts,
and it keeps a note for each: the problem (`problem.md`: the background, and
what the problem is), the solution (its deliverables: how things must be
once it is solved), and the log of the decisions that steered it. Beside
them it keeps the resources the work refers to, your own drafts, and, when
it touches a repository, a worktree of its own. `yan` keeps those and
nothing else.

An agent knows about them when you start it through `yan`. Type `yan`, pick
a task or start one, and Claude, Codex or Agy starts in the task's worktree.
Claude is given yan's skills, which say how to work in a task, and is told
in four lines that the task is yan's, where its files go and which skills
there are; Codex and
Agy take no skills that way, so they are told it all in their opening
prompt. Start the same agent directly and it hears of yan only if it has the
skills.

## Getting started

```sh
npm run setup                     # install, build, npm link
yan vault init personal --remote git@github.com:you/yan-vault-personal.git
```

`yan vault init` needs an empty repository on your forge first. On a second
machine, `yan vault clone <url>` instead.

Then register the repositories you work in, with `yan repo add` in a clone
or in the directory that holds them, and type `yan` anywhere.

## What there is

Bare `yan`, at a terminal, picks an open task or starts one, and runs the
agent on it in this terminal, with its approvals skipped (`"skipPermissions":
false` in the vault's `config.json` hands them back). A new task picks
the repositories it works in from the registry, and gets a worktree of each
on a detached HEAD at origin's default branch; in a monorepo it also asks
which packages the task is about, once. yan never makes a branch, since each
machine names its branches its own way: the agent is told to cut one before
it commits, and every `yan vault push` keeps the branch each open task's
tree is on, as origin names it. A task may have several branches in one
repository, in a monorepo one for each app it changes, the one tree
switching between them, so a branch the tree moves off stays in progress:
until a merge commit takes it into origin's default branch, which yan reads
from git, or it is fast-forwarded in, or until the agent marks it given up
with `yan branch abandon`,
which the agent is told to do once the work has left it for another. A tree
opened later for the task, on any machine, is put on the branch it was last
on: the clone's own, brought up to origin's when it is only behind it, or a
new one tracking origin's; one yan cannot put there starts detached, and
says why; the agent is told the task's other branches still in progress.
A fast-forward leaves no merge commit, and git alone cannot tell a branch
fast-forwarded in from one just cut, so each push also notes, while the
tree's branch has commits of its own, where it last met the default branch:
the point moves on each time the default branch is merged in, and a branch
the default branch has, with commits after its point, was merged.
Every step, the worktrees included, is a line on the one chain
the questions are on. The agent starts in the first tree, with the others
added beside it.

How to work in a task is in yan's skills, a plugin in `plugin/`:
`yan:recap`, which the agent uses at the start of a session to read the task
and which holds the rules for keeping its notes, its files, its resources and
its branches; `yan:define`, to work out the problem and the solution with
you; `yan:uat`, once an implementation is done and its result can be
verified interactively; and `yan:done`, which only you start, to close a
task. Claude is started with them (`--plugin-dir`), and its prompt says only
that the task is yan's, where its files are and which folder takes what,
which skills there are, and that an implementation ends with `yan:uat`. A skill can be carried where yan does not start the
agent and so cannot give it a prompt. A machine can give claude skills of
its own besides, such as the ones a workplace keeps: `skillDir` in
`~/.yan/config.json`, a folder or a list of them, `~` for the home
directory, each passed to `--plugin-dir` as it is. Each is a plugin, its
skills in `skills/<name>/SKILL.md` and called `<plugin>:<name>`, the plugin
named by its `.claude-plugin/plugin.json` or else by its folder, or a folder
of plugins. A `skillDir` that is not a folder stops bare `yan` before it
asks anything. Codex and Agy take no plugin, so their
prompt says it all: which tree is which and what in them the task is about,
where the task's own files are, how the branches are kept, and how the
evidence is gathered.

`yan:uat` gathers what you check the result by in artifacts/uat/,
deliverable by deliverable, in one pass after the implementation: the before
of each change from the code where the task's branch left the default
branch, run in a directory of its own, and the after from the worktree; a
recording captioned, in the page itself, with what is happening as it
happens, and the white screen a large Vite project opens on cut off. Each
file is named for what it shows (d3-before.png, d3-after.png) and recorded
with `yan uat`, or a note says how a deliverable was checked where nothing
on screen shows it. When the result is checked on the web, it tries to give
you a link that opens the version with this work, one for the task unless a
wholly different app or page needs its own, leaving how to get it to
whatever knows the platform; each is kept as a preview named for what it
opens, so a newer one replaces it, and the report lists them as the last
row of its header. It builds the report, then marks the task 验收中 with
`yan uat ready`. Designs of what you will see go in artifacts/design/,
written documents in artifacts/docs/, and anything else worth keeping, a
script, a query or data pulled for a check, in artifacts/misc/, so nothing
sits loose in artifacts/ but the report; what can be made again and
only takes room, installed dependencies or a checkout of old code, stays out
of the vault. An artifact redone replaces its file; the vault's history
keeps the old one.
While it runs, the vault is kept in step with your other machines without
the agent being told: it is pulled each time you send a message and pushed
each time the agent finishes a turn, by hooks given to that session alone
(claude's `--settings`, codex's `-c`, with codex's hook trust bypassed for
the session). agy takes hooks only from files, so under agy the vault is
pulled and pushed by hand. A push keeps the branch each tree is on, commits
everything in the vault and rebases it onto the remote first; a conflict
stops it, the commit kept here, and the hook says so.
`--cli codex` runs another agent this once; anything after `--` goes to the
agent as it is.

For you:

- `yan ls` — every open task, one line each, those handed to you to accept as 验收中; `--status all` for the rest
- `yan peek [id]` — one task at a glance: its trees, the start of its problem, its resources and newest drafts
- `yan done [id]` — close a task and give its worktrees back; `--abandon "<why>"`
- `yan draft [id]` — your own notes about a task, in your editor
- `yan serve` — the vault in the browser on this machine, kept up to date as agents push: every task, those waiting for you to accept them apart, its notes and branch, every artifact shown as what it is, and its report to check each deliverable on
- `yan vault …` — init, clone, use, pull, push, where, ls
- `yan repo add|link|ls|rm` — the repositories a new task picks from, and where each is cloned here
- `yan debug [id]` — what yan tells an agent: the opening prompt a start of the task would give now; `--cli` for another CLI's

For the agent:

- `yan context` — a summary to start from: the task's problem in full, its deliverables and resources, its artifacts by folder, and where each branch stands (ahead of the default branch, unpushed, uncommitted, and every branch the task kept, in progress, merged or abandoned), with the packages a task in a monorepo is about; `--json` lists every artifact with its web address in the vault's repository, for a report or a recap to build on
- `yan log` — what earlier sessions settled; `yan log agreed|changed|paused "<line>"` records one
- `yan deliverable add|edit|done|abandon|rm|move` — the solution, in Chinese unless you ask for another language, changed only when you agree to a different one. A deliverable's number is its place in the list, from d1 with no gap: `rm` takes out one that should never have been on it, as if never added, and `move` puts one at another place; the ones after renumber, and uat.json and the names of the files in artifacts/uat/ follow
- `yan uat [add|note|rm]` — what you check each deliverable by: each file in artifacts/uat/ with the deliverables it shows and what it shows of them, a note for one nothing on screen can show; bare, every deliverable with its evidence and which have none
- `yan uat ready` — the task is handed to you to accept: its state becomes `uat`, shown as 验收中, and stays so through the changes your feedback asks for until `yan done`
- `yan resource add|rm|ls` — anything the work refers to, under a name, as one of: `spec` (ticket, PRD, design), `mr`, `preview` (a link to the deployed version), `run` (a sub-task elsewhere), `general`
- `yan branch [name]` — keep a branch for the task by hand; a push keeps the one each worktree is on, and each stays in progress until it is merged or marked given up
- `yan branch abandon <name>` — mark a branch given up, once the work has left it for another; nothing is deleted, and the tree moving back onto it opens it again
- `yan learn add|ls` — a learning, written only when you ask for one

`yan <command> --help` says the rest. Every command that takes a task reads
`$YAN_TASK` when none is given, which is what `yan` sets for the agent it
starts.

`yan serve` runs until stopped, at `http://localhost:4747` (`--port`). At a
terminal it takes a screen of its own, as `less` does, with no history to
scroll back through: the page's address, the vault it serves and how often
it fetches, a line each under an arrow, the address in colour. Stopping it
puts the terminal back as it was, with a line saying it stopped. Every
10 seconds (`--every`) it fetches the vault into refs of its own,
`refs/yan/serve/`, and reads git objects rather than the work tree, so
nothing an agent or a hook works with moves; an open page follows without
being reloaded, and changes only what moved: a push fetches again only the
tasks it touched, and a page left half read stays where it was, with what
is selected, typed or playing in it. Left running while yan is updated, it restarts on the newer
build by itself once that build is complete and starts, in the same process
and on the same port, and an open page reloads onto it. With the bell beside Latest on, Chrome shows a silent macOS
notification when a push arrives, the task's name as its title and nothing
else, and clicking it opens Latest on that push; the page has to be open for
it, in the background or minimised, and Chrome's permission is asked on the
first click. Each push's line in Latest opens to the files it brought, and
the arrow at its end opens the task's overview. A file a push added or
changed carries a dot, in its task and in Latest, until it is opened, or,
when the push changed it while it was open, until it is clicked in; it
lights again when it changes again, and the page being open, in front or
not, counts for nothing. A task stays in Latest and in its count until its
last dot is gone, and 全部已读 beside its Artifacts clears them all at once,
as Log's dot goes when the log is opened. Images, pages, Markdown, code, logs, audio, video and fonts
open in place, and prev and next walk a folder. A picture shown small, in a
list, a folder's grid or beside the picture open, is a small copy the
server makes of it once, with sharp; the picture itself is loaded only when
it is opened, so a folder of screenshots costs the page no more than a
screenful of thumbnails. A task that keeps a branch
shows it against origin's default branch, from this machine's clone: its
changed files and their diffs, its commits, and every file at its head. A
commit's files are listed at once and their lines drawn as they are
scrolled to, so one of tens of thousands of lines opens without a wait. The
task's nav has a Branch row for each repository, folded, that names no
branch and counts those in progress; unfolded, it lists every branch the
task kept there, those in progress first, the one its tree was last on
leading them, then those merged with their pull request, then those
abandoned. A click on a branch copies its whole name and opens it. Code
is coloured by its language, in a diff, in a file and in a Markdown fenced
block alike, by highlight.js, built into the page, so the page still fetches
nothing from the network; a language outside the common set is loaded the
first time a file needs it, and a file whose language yan does not know
stays plain. A
branch already merged is compared from where it left, and its merge commit
names the pull request, so it shows the same change however far the default
branch has moved since; one deleted from origin is found again from what its
merge commit says. One fast-forwarded in is compared from the point the
last push noted, so it shows only its own change; when the default branch
was merged into it again after that push, the diff also carries what that
merge brought. The artifacts are served on the next port up, so a
page an agent wrote runs as its own site and cannot reach the one around it.
A file's open button goes to its page on the vault's forge, GitHub, GitLab
or what the vault's config.json `artifactLinks` says, so the link can be
passed on once the vault is pushed; only for a forge yan cannot tell does it
open this machine's copy. A branch's commits and files open on GitHub or
GitLab the same way.

A task its agent marked with `yan uat ready` is listed under 验收中, above
the ones in progress, and its overview's tag says so. Those done or given up
are listed under Done by the month they closed in, each month folded, with
how many it holds, until it is clicked open; a folded month still shows the
task being read, and a dot when one of its tasks has something new. A
task's artifacts are its folders' tree, and nothing more. It stays there while
changes are made on your feedback; nothing turns it back to in progress,
and accepting it is `yan done`, as for any task.

A task's overview is where its problem and deliverables are put right while
they are still being defined. 编辑 opens problem.md whole, as Markdown, and
saving is refused when an agent changed it since the page read it. A
deliverable's text is edited where it stands. Under its date on hover, one
button gives it up, with a reason that stays on its line and is edited the
same way, and the bin deletes it, once you confirm, as if it had never been
added: the ones after it take its number. A resource's pencil edits where it points, keeping its
kind, and its bin forgets it. What you are typing, in a text or in the
problem, stays as it is while new commits arrive, so nothing typed is lost.

A task with an artifacts/report.html, the page `yan:uat` writes from
what `yan uat` recorded, has a Report beside its overview. Each deliverable
is shown there as task.json has it now: tick it done, untick it, give it
up with a reason or edit the reason it was given up for, and task.json
changes; click a text of the page and edit it, and report.html changes. Every change made on the overview or the report is committed and pushed as
`yan vault push` would; those are the only writes `yan serve` makes, and
only from its own page.
report.html carries its pictures inside it, so it can be dragged into a
document whole; the page is sent it with them taken out, and loads each
beside it as it comes into view.
A picture clicked opens large in a modal over the page, ← and → going
through the others; recordings play in place, full screen from their own controls, with
their link to copy; every file in uat/ can be downloaded, and the page itself downloads with the deliverables in the state
they are in, less the ones given up: the copy is a report to hand to others, so
what was given up is left out with its pictures, the counts are of the rest,
and on a page that numbers its deliverables by place they are numbered from
1 again under each heading, so one given up leaves no gap. When a deliverable was reworded or added, or a file of evidence recorded,
replaced or dropped since the page was written (report.json beside it says
what it was written from), its bar says legacy and what changed.

## Where things are

```
<vault>/                       a git repository, one per context (personal, work)
  vault.json                   { version: 2, name, created }
  config.json                  { cli, model, effort, skipPermissions }: the agent bare yan starts; artifactLinks: how a vault file opens on a forge yan cannot tell, an http(s) address
  repos.json                   { version: 1, repos: { <name>: { url } } }: what yan repo registered
  learnings/<topic>.md         front matter (name, description) and the text
  tasks/<id>/
    task.json                  title, state (open, uat, done, abandoned), repos (URL, scope, the branch the tree was last on, the task's other branches, each one marked open or abandoned, and where each last met the default branch), deliverables, resources and their kinds
    problem.md                 prose: the background, and what the problem is (brief.md before)
    log.md                     - MM-DD  type  line, appended only
    drafts/<draft-id>.md       yours, in the format of the `draft` CLI
    artifacts/                 whatever the work produced worth keeping, as it stands now
      report.html              the report yan:uat writes, report.json beside it: the only files loose here
      design/                  what you will see: pages, canvases, mockups, palettes, icons, and the scripts that build them
      docs/                    written documents: a technical design, research notes, a review, a handoff, a diagram of a system
      uat/                     screenshots and recordings to check the result by: d3-before.png, d3-after.png, d3.webm
        uat.json               { version: 1, files: { <path>: { for, shows, side?: before|after|new } }, notes: { <d>: how } }: what yan uat recorded
      misc/                    anything else worth keeping: a script, a query, data pulled for a check
~/.yan/config.json             which vaults this machine has, the active one, and where each repository is cloned; skillDir: plugin folders claude is started with here, besides yan's
~/.yan/trees/<repo>-<hash>/    the worktree pool: <slot>/<repo>/ and leases/
```

The pool keeps its trees. Returning one resets and cleans it but keeps what
git ignores, so the next task in that slot starts with `node_modules` in
place, and takes it off any branch the agent cut, so the branch can be
checked out anywhere else. `yan done` refuses to return a tree holding
uncommitted or unpushed work; `--force` throws that work away, and never a
branch.

## Third-party material

`templates/fonts/` holds two woff2 subsets of **ChillRoundF** (寒蝉全圆体)
by ChillType, the face `yan serve` draws in, under the SIL Open Font
License 1.1. `templates/fonts/OFL.txt` is the licence and the copyright
notice, and the `README.md` beside it says what is in the subsets and how they
were cut. `templates/fonts/` also holds **0xProto** by 0xType, the face code is
shown in, as its own woff2 files, unchanged, under the SIL Open Font License
1.1, with `OFL-0xProto.txt` as its licence. Everything else here is yan's own.
