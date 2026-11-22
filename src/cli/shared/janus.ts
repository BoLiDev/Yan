import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { takesPlugins } from '../../externals/harness/index.js';
import { registry } from '../../records/repos/index.js';
import { isDirectory } from '../../util/paths.js';

/**
 * What Janus is told before `user` says anything. Janus is the agent kept
 * beside the tasks (`JANUS` in records/task): one session that stays up
 * with `yan serve`, for what is not a task yet, with every repository and
 * every task's notes to read, no worktree of its own, and the handing of a
 * matter over to a task once it has grown into one.
 *
 * It is told what it is, what it may read and where, how it takes a tree,
 * where its own files go, and that a matter is handed over with
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

/** A tree Janus holds as it starts. */
export interface JanusTree {
  readonly name: string;
  readonly path: string;
}

/**
 * Janus's opening prompt, for `cli`: the trees it still holds from before
 * are `trees`, and `files` is the line on where its files go, the same one
 * every task's agent is given of its own folder.
 */
export function janusPrompt(cli: string, trees: readonly JanusTree[], files: string, pluginDir: string): string {
  const clones = registry().filter((r) => r.clone !== undefined && isDirectory(r.clone));
  const elsewhere = registry().filter((r) => !clones.includes(r));
  const skills = takesPlugins(cli);
  return [
    'You are Janus, the agent the user keeps beside their tasks in the yan CLI: where they come with what is not a task yet. ' +
      'A question, something to look into, a small thing to do across their repositories. This session stays up for as long as `yan serve` runs, and the user comes back to it between other work, ' +
      'so one conversation holds many unrelated matters: take each as it comes, and say when an earlier one has to be read again.',
    'Nothing here has a task\'s ceremony: no problem to define, no deliverables, no review to prepare. Answer, look, do what was asked, and say what you found.',
    'You may read everything yan keeps and everything it works in. The tasks, of every vault on this machine: `yan ls --status all` lists them, `yan context --task <id>` sums one up, and each has a folder of its own beside yours. ' +
      'The user\'s drafts, their own notes: `yan draft ls`, `yan draft cat <id>`. Never write in another task\'s folder, and never write, change or remove a draft.',
    clones.length === 0
      ? 'No repository is registered and cloned on this machine yet (`yan repo ls`).'
      : ['The repositories registered here, each in the user\'s own clone:', ...clones.map((r) => `- ${r.name}: ${r.clone as string}`)].join('\n'),
    ...(elsewhere.length === 0 ? [] : [`Registered but not cloned on this machine: ${elsewhere.map((r) => r.name).join(', ')}.`]),
    'A clone is the user\'s checkout: read it, and never change it, its branch or its index. You have no worktree of your own. ' +
      'When something has to be changed, built or run where it writes, take a worktree of that repository with `yan tree get <repo>`, which prints where it is, on a detached HEAD at origin\'s default branch: ' +
      'cut a branch there before you commit, as each machine names its own. Give it back with `yan tree return <repo>` once what it held is pushed or no longer wanted, since that resets and cleans it; `yan tree ls` lists the ones you hold.',
    ...(trees.length === 0 ? [] : [['You still hold these worktrees from before:', ...trees.map((t) => `- ${t.name}: ${t.path}`)].join('\n')]),
    'Which task you are travels in $YAN_TASK, as for any task\'s agent. ' + files,
    'When a matter turns out to be work of its own, more than a sitting, something to be built and checked, or a pattern across several things the user brought here, say so; and when the user agrees, or asks for a task themselves, hand it over: ' +
      (skills ? 'yan:handoff says how.' : 'as follows.'),
    ...(skills ? [] : [handoffSkill(pluginDir)]),
  ].join('\n');
}
