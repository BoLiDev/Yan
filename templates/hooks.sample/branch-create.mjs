#!/usr/bin/env node
//
// <vault>/hooks/branch-create - SAMPLE (td boundaries.md §10).
//
// ---------------------------------------------------------------------------
// WHICH KIND OF HOOK THIS IS
// ---------------------------------------------------------------------------
//
// NOT one of the hooks the agent harness runs. Those live in the mechanics
// clone (bin/hook-*.sh, .claude/settings.json) and they call yan. This is the
// other direction: a hook YAN CALLS, to have an outside authority do something
// yan must not do on its own initiative.
//
// It lives in the VAULT rather than the code, because what it encodes is your
// context's rule and not yan's behaviour: a company repository that requires
// feat/<ticket>, or a branch opened through a ticket system, is true at work
// and meaningless at home — and it follows you to your other work machine. The
// vault is versioned and pushed, so unlike the old conf/hooks/ this file
// TRAVELS. Bear that in mind: it is an executable that arrives over git.
//
// To use it:
//
//     cp "$YAN_HOME/templates/hooks.sample/branch-create.mjs" "$(yan vault where)/hooks/branch-create.mjs"
//
// The extension is how yan knows to run it with node — keep it. A hook with no
// extension is run directly when it is executable, and through bash otherwise,
// which is the normal case on Windows where the executable bit does not
// survive a copy. `.mjs` `.cjs` `.js` `.py` `.sh` are all understood.
//
// ---------------------------------------------------------------------------
// WHAT IT IS FOR
// ---------------------------------------------------------------------------
//
// IT CREATES THE INTEGRATION BRANCH. Not "suggests a name" — creates. A
// company tool typically opens the branch on the forge or through a ticket
// system and then reports what it called it, and that is exactly the shape
// this contract has. yan then CHECKS the branch exists (locally, or on the
// remote after a fetch) and refuses to record it if it does not. Taking the
// hook's word for it would write a name into task.json whose first symptom
// would appear two commands later, inside the worktree pool.
//
// WHAT IT IS NOT FOR: inheriting the previous round. Cut the branch wherever
// your team cuts branches — normally straight off the repository's main branch
// — and do not try to carry old work forward. Not losing commits is a
// judgement about work rather than a naming rule, so yan does it afterwards,
// itself, once the branch is known to exist.
//
// The hook is entirely optional. With none installed, yan names the branch
// yan/<task>-<unit>-r<n> and cuts it itself, which is the ordinary case.
//
// ---------------------------------------------------------------------------
// THE CONTRACT
// ---------------------------------------------------------------------------
//
//   in     JSON on stdin, so fields can be added later without breaking a hook
//          that is already installed:
//
//            { "task": "t042", "task_title": "unify the auth header",
//              "unit": "auth", "repo": "monorepo-x",
//              "repo_dir": "C:/workspace/project/monorepo-x",
//              "target": "master", "scope": ["apps/auth"], "round": 1 }
//
//          `repo_dir` is where that clone is ON THIS MACHINE. It is handed to
//          you because a hook has no business reading the vault's .local/.
//
//          Read only the fields you need. Ignore the rest, and do not fail
//          when a field you have never seen turns up.
//
//   out    ONE LINE on stdout: the branch you created. If the hook chatters
//          while it works that is fine — yan reads the LAST non-empty line,
//          because creating the branch usually prints something first.
//
//          Spelling is forgiving: refs/heads/x, origin/x, "x" and a trailing
//          CR all arrive as `x`. Anything still not a usable ref is refused,
//          and the message quotes what you actually printed.
//
//   err    WHY, when you refuse. It reaches `user` and the agent verbatim,
//          inside the error — "exit 3" on its own tells nobody anything.
//
//   exit   0        yan verifies the branch and records it.
//          non-zero yan STOPS and reports your message. It never falls back to
//                   its built-in default: after your tooling has refused, a
//                   branch quietly invented by yan would break your rules and
//                   might not be mergeable at all.
//
// yan never parses the name to work out who owns a branch (td branching.md
// §6.6) — that is looked up in task.json. It normalises the spelling and
// nothing else.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Everything yan knows about the unit this branch is for. */
const ctx = JSON.parse(readFileSync(0, 'utf8'));

const git = (...args) =>
  execFileSync('git', args, { cwd: ctx.repo_dir, encoding: 'utf8' }).trim();

// --- decide the name -------------------------------------------------------
//
// Replace this with whatever your team actually does. Three shapes people
// reach for, in rising order of how much they involve the outside world:
//
//   1. a convention          feat/<unit>
//   2. a convention that stays unique across rounds, because the integration
//      branch is replaced wholesale (td branching.md §6.3):
//                            feat/<unit>-r<round>
//   3. ask real tooling      the ticket system opens it and names it; see the
//                            refusal below for what to do when it says no.

const round = Number(ctx.round ?? 1);
const target = ctx.target || 'main';

let name = String(ctx.target ?? '').startsWith('release/')
  ? `hotfix/${ctx.unit}`
  : `feat/${ctx.unit}`;
if (round > 1) name += `-r${round}`;

// --- create it -------------------------------------------------------------
//
// Off the main branch, deliberately. Carrying the previous round forward is
// yan's job and it will do it after this returns.

try {
  git('fetch', 'origin', '--quiet');
  const base = `origin/${target}`;
  git('rev-parse', '--verify', '--quiet', base);
  git('branch', '--force', name, base);
  git('push', '--quiet', '-u', 'origin', name);
} catch (err) {
  // A refusal is an answer. Say why: this text is what `user` sees.
  process.stderr.write(`could not create ${name} off origin/${target}: ${err.message}\n`);
  process.exit(1);
}

process.stdout.write(`${name}\n`);
