# Charters

What each walker is sent to walk. A charter names the ground, the parts of
the spec to read before setting out, a few first moves, and how to tell
something is wrong there; it is not a script. A walker that finds the
ground exhausted goes sideways into the next one rather than stopping.

The spec for all of them is README.md (what yan does), `yan <command>
--help`, and the "Rules of the design" in AGENTS.md.

## launch: bare yan and a task's life

Bare `yan` picking, starting, closing and pausing tasks, and the worktrees
that come and go with them.

- Read: README's "What there is" up to "For you", and the list under "For
  you"; `yan --help`'s epilogue.
- Ground: bare `yan` at a terminal (tmux for its questions, script(1) with
  flags), `--new`, `--repo name[:pkg,...]`, `--no-repo`, `--task`, `--cli
  codex|agy`, `--done`, `--abandon`, `--pause`, `--` with extra args; `yan
  ls`, `peek`, `done`, `pause`, `resume`, `debug`; the worktree pool under
  ~/.yan, the trees a task gets, a monorepo's packages, the branch a tree is
  put on when a task is opened again; what the fake agent was started with
  (agent-calls.jsonl: argv, cwd, $YAN_TASK, the hooks, the prompt).
- First moves: answer bare `yan`'s questions in tmux the long way, then
  wrongly (Escape, Ctrl-C half-way, a title of spaces); start the same task
  twice at once; pause a task whose tree has uncommitted work; resume and
  start it again and see which branch its tree is on; close one with
  `--abandon ""`.
- Wrong looks like: a question answered and ignored; a tree left behind or
  taken from another task; work lost from a tree; the agent started in the
  wrong place or told the wrong task; a paused task offered or started; a
  stack trace instead of `yan: <message>`.

## agent: the commands an agent runs in a task

What the agent keeps through yan while it works, read back the way the
user and the next session will read it.

- Read: README's "For the agent" list, and the `--help` of each command in
  it.
- Ground: `yan context` (and `--json`), `deliverable add|edit|done|abandon|rm|move`,
  `uat [add|note|rm]`, `uat ready`, `resource add|rm|ls`, `log`, `say`,
  `branch`, `branch abandon`, `learn add|ls`, `draft ls|cat|search|dir`;
  run inside a task's tree with $YAN_TASK (the fake agent's MONKEY_AGENT_DO,
  or `. env-a.sh && export YAN_TASK=t001 && cd <tree> && ...`) and with
  `--task`.
- First moves: add five deliverables, record uat files for three, then `rm`
  and `move` deliverables and check the uat records and the files in
  artifacts/uat/ still say the same thing about the same deliverable; keep
  two branches in one repo, abandon one, keep it again; `say` something
  longer than 200 columns, in Chinese; compare `context` with `context
  --json` field by field.
- Wrong looks like: numbering with a gap or a duplicate; a uat record
  pointing at the wrong deliverable after a renumber; JSON that does not
  parse or disagrees with the text; a command that changed task.json fields
  it does not own (diff it before and after); something written that is not
  committed and pushed when the README says it is.

## sync: two machines and one vault

The vault shared through git by machines that change it at the same time,
and that run different builds.

- Read: README's "Getting started", the paragraph on hooks under "What there
  is", and the AGENTS.md rule on a vault shared across machines.
- Ground: `vault init|clone|use|pull|push|where|ls`, `repo add|link|ls|rm`
  on both machines; the hooks the fake claude runs; the same task changed on
  A and B before either pushes; tasks made on both; drafts written on both;
  a task.json with a field this build does not know (add one by hand, then
  have yan edit the task and see it kept); the origin moved behind yan's back.
- First moves: make a task on each machine without pulling in between and
  look at the ids and at what each machine lists after both push and pull;
  edit the same deliverable on both; pause on A while B's agent says
  something; corrupt a task.json by hand and run every reading command.
- Wrong looks like: two tasks under one id; a push or pull that leaves the
  vault mid-rebase without saying how to get out; a change silently lost;
  a field this build does not know dropped on a rewrite; something of one
  machine (a clone's path, a terminal) written into the vault.

## serve: the page

`yan serve`'s page in Chromium, while the machines change the vault under it.

- Read: README from "`yan serve` runs until stopped" to the end.
- Ground: the task list, the rail when it is folded, Latest and its dots,
  Drafts' box (writing, pictures, a conflict with a draft changed elsewhere,
  delete), a task's overview (editing the problem and deliverables in
  place), Report, Log, MR (branches and diffs), Resources, Agent, the task
  menu (Rename, Pause, Done, Abandon, Resume), the new task box, ⌘K, Tab
  through the nav, dark and light, toasts and bubbles from `yan say` pushed
  from machine B; with the fake herdr (`herdr.mjs`) a task's Terminal and
  Latest's Agents. Check for updates acts on the sandbox's copy of yan,
  which is not a clone; it should say so, not touch the checkout.
- First moves: open the page, push from B (a say, a new artifact, a renamed
  task) and watch what changes and what stays put; type in an editor while a
  push arrives; double-click every button that changes something; resize
  to 390 wide; reload in the middle of a box.
- Wrong looks like: anything in "the page said" (page errors, console
  errors, failed requests, 5xx); a push not shown after two ticks; text typed
  lost; a dot that never clears or never lights; a layout that overflows or
  overlaps; a box whose button does nothing; what the page sends differing
  from what lands in the vault (check `git -C <vault> log -p -1`).

## abuse: what nobody meant to type

Hostile and careless input across every command and the page: yan should
refuse clearly or cope, never corrupt.

- Read: `yan --help` and the `--help` of every command; the README where a
  command takes a name, a path, an id or free text.
- Ground: titles, names, deliverables, log lines and says that are empty,
  only spaces, 10 000 characters, multi-line, Chinese, emoji, right-to-left,
  NUL-adjacent control characters, `../`, `-flag`-looking, shell quotes;
  ids that do not exist, of a done task, `t1` vs `t001`; flags repeated, in
  odd orders, combined against their help (`--done --pause`); output piped
  into `head` or closed early; commands interrupted (`timeout -s INT 0.3
  ...`) and run twice at once; files and folders yan keeps, deleted,
  emptied, made read-only or replaced with a directory; a vault with no
  origin; a disk path with spaces.
- First moves: one bad input per command from `yan --help`, rolling `dice`
  for which; then a run of commands each interrupted at a random moment,
  checking after each that `yan ls`, `peek` and `context` still read the
  vault and `git -C <vault> status` is clean or explains itself.
- Wrong looks like: a stack trace, EPIPE or `Unhandled 'error' event`; exit 0
  on a refusal; a half-written file; a name that escapes its folder; a lock
  left held; anything yan writes outside the sandbox.
