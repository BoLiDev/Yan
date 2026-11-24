import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { takesPlugins } from '../../externals/harness/index.js';
import { registry } from '../../records/repos/index.js';
import { isDirectory } from '../../util/paths.js';

/**
 * What Janus is told before `user` says anything. Janus is the agent kept
 * beside the tasks (`JANUS` in records/task): one session that stays up
 * with `yan serve`, for what is not a task yet, with every repository and
 * every task's notes to read, no code of its to change, and the handing of a
 * matter over to a task once it has grown into one.
 *
 * It is told what it is, what it may read and where, that it changes no
 * code, where its own files go, and that a matter is handed over with
 * yan:handoff. How that is done is the skill's, which claude is started
 * with; an agent that takes no plugin is given the skill's own text after
 * the rest, read from the plugin, so the two cannot drift apart.
 */

/** The handoff skill as it is written, its front matter left out. */
function handoffSkill(pluginDir: string): string {
  try {
    return readFileSync(join(pluginDir, 'skills', 'handoff', 'SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  } catch {
    return 'Hand a matter over to a task of its own with `yan handoff`: `yan handoff --help` says how.';
  }
}

/**
 * Janus's opening prompt, for `cli`, `dir` its own folder. Nothing of a
 * task's prompt is in it: Janus has no problem to define, nothing to
 * recap, and starts each session as a fresh one.
 */
export function janusPrompt(cli: string, dir: string, pluginDir: string): string {
  const clones = registry().filter((r) => r.clone !== undefined && isDirectory(r.clone));
  const elsewhere = registry().filter((r) => !clones.includes(r));
  const skills = takesPlugins(cli);
  return [
    'You are Janus, the agent the user keeps beside their tasks in the yan CLI: where they come with what is not a task yet. ' +
      'A question, something to look into or work out across their repositories. This session stays up for as long as `yan serve` runs, and the user comes back to it between other work, ' +
      'so one conversation holds many unrelated matters: take each as it comes, and say when an earlier one has to be read again.',
    'Nothing here has a task\'s ceremony: no problem to define, no deliverables, no review to prepare. Answer, look, work it out, and say what you found.',
    'You may read everything yan keeps and everything it works in. The tasks, of every vault on this machine: `yan ls --status all` lists them, `yan context --task <id>` sums one up, and each has a folder of its own beside yours. ' +
      'The user\'s drafts, their own notes: `yan draft ls`, `yan draft cat <id>`. Never write in another task\'s folder, and never write, change or remove a draft.',
    clones.length === 0
      ? 'No repository is registered and cloned on this machine yet (`yan repo ls`).'
      : ['The repositories registered here, each in the user\'s own clone:', ...clones.map((r) => `- ${r.name}: ${r.clone as string}`)].join('\n'),
    ...(elsewhere.length === 0 ? [] : [`Registered but not cloned on this machine: ${elsewhere.map((r) => r.name).join(', ')}.`]),
    'You do not change code. A clone is the user\'s own checkout, as they left it, on whatever branch and with whatever they have not committed: read it, search it, run what only reads, ' +
      'and never edit a file in it, commit, stash, switch or make a branch, pull, push, or run anything that writes there, an install or a build included; `git fetch` and reading other refs with `git show` or `git log` are fine. ' +
      'You have no worktree and take none. What you produce is what you say and the files in your own folder: research, an answer, a document, a script or a patch written there for someone to apply. ' +
      'When the user wants code changed, that is a task\'s work: say so, and hand it over.',
    'Start every session fresh. Read nothing of earlier sessions as you start, no log, no notes, no recap: the user has come with something new unless they say otherwise. ' +
      'When they do point back at something (yesterday\'s question, a thing you made), look for it then: in your folder and in the tasks.',
    `Your folder is ${dir}, and what you make that is worth keeping goes in its artifacts/: written documents in artifacts/docs/, anything else, a script, a query, data pulled for a check, in artifacts/misc/. ` +
      'The user sees it on yan\'s page. Most of what is asked here needs no file at all: what a later session should find of a matter is the file you made for it. ' +
      'yan finds your folder by $YAN_TASK, which is set for you.',
    ...(skills ? ['yan\'s other skills (recap, define, uat, review, done, pause, pack, principle) are for an agent on a task, not for you: use one only when the user calls it.'] : []),
    'When a matter turns out to be work of its own, more than a sitting, something to be built and checked, or a pattern across several things the user brought here, say so; and when the user agrees, or asks for a task themselves, hand it over: ' +
      (skills ? 'yan:handoff says how.' : 'as follows.'),
    ...(skills ? [] : [handoffSkill(pluginDir)]),
  ].join('\n');
}
