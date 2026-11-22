import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { keptIn } from './shared/branches.js';
import { byKind } from './shared/resources.js';
import { tildePath } from './shared/style.js';
import { requiredTask } from './shared/task-id.js';
import { leasesHeldBy } from '../externals/worktree/index.js';
import { branchMark, type TaskData } from '../records/task/index.js';
import { YanError } from '../util/error.js';
import { git } from '../util/git.js';
import { machineDir } from '../util/machine.js';
import { isDirectory, isInside, normalizePath } from '../util/paths.js';
import { localDay } from '../util/time.js';
import { vaultDir } from '../util/vault.js';
import { writeZip, type ZipEntry } from '../util/zip.js';

/**
 * `yan pack [task-id]` — one task as a zip, for an agent that works where
 * the vault is not: a local vault is pushed nowhere, so a task goes to an
 * agent in the cloud by hand, `user` giving it the archive. In it, under
 * one folder: a README.md written here for that agent, the task's folder
 * as it is under `task/`, and the vault's learnings. The drafts are
 * `user`'s own and mostly about other work, so they stay unless asked for.
 *
 * It holds what the vault would commit, git's own list of it, so what
 * .gitignore keeps out of the vault stays out of the pack; a symbolic link
 * is left out, since following one could carry anything off the machine,
 * and so is a dot file.
 * Nothing in the vault is written: packing is a copy out, and what the
 * other agent does comes back as `user` carries it.
 */

/** Where a pack goes when nobody said: where `user` drags files from, or yan's own folder on a machine with no Downloads. */
function defaultOut(id: string): string {
  const downloads = join(homedir(), 'Downloads');
  return normalizePath(join(isDirectory(downloads) ? downloads : join(machineDir(), 'packs'), `yan-${id}.zip`));
}

/** Every file under `dir`, from `base`, for a vault git cannot list. */
function walk(dir: string, base: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = join(dir, name);
    const rel = `${base}${name}`;
    try {
      return lstatSync(full).isDirectory() ? walk(full, `${rel}/`) : [rel];
    } catch {
      return [];
    }
  });
}

/**
 * The files under `under` the vault holds or would commit, from its root,
 * as git lists them: tracked, or untracked and not ignored. A vault git
 * cannot list, one that is no repository, is walked instead.
 */
function vaultFiles(vault: string, under: string): string[] {
  const listed = git(vault, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', under]);
  const found = listed.code === 0 ? listed.stdout.split('\0').filter((p) => p !== '') : walk(join(vault, under), under);
  return [...new Set(found)].sort().filter((rel) => {
    // A dot file is git's or a tool's, a .gitkeep or a .DS_Store, and says nothing of the task.
    if (rel.split('/').some((part) => part.startsWith('.'))) return false;
    try {
      return lstatSync(join(vault, rel)).isFile();
    } catch {
      // Deleted here and not committed yet: not in the vault any more.
      return false;
    }
  });
}

/**
 * What the agent given the pack reads first. It has no yan and no vault, so
 * this says what `yan context` would have: what the task is, which file
 * holds what, the deliverables, the repositories and branches, the
 * resources; and what a skill would have: that the notes here are copies,
 * and what to hand back for `user` to carry home.
 */
function readme(data: TaskData, has: { problem: string | undefined; log: boolean; artifacts: boolean; learnings: boolean; drafts: boolean }): string {
  const lines: string[] = [
    `# ${data.id}: ${data.title}`,
    '',
    `One task, packed on ${localDay()} by yan, a CLI that keeps a task's notes from one agent session to the next. yan and its vault are not here: these files are copies, and no \`yan\` command works on them.`,
    '',
    '## What is here',
    '',
    has.problem === undefined ? '- No problem is written yet.' : `- \`task/${has.problem}\`: the problem, its background and what is wrong or wanted.`,
    '- The deliverables, below: the solution, how things must be once the problem is solved.',
    ...(has.log ? ['- `task/log.md`: the decisions that steered the work, oldest first. The latest `paused` and `changed` lines say where it stopped.'] : []),
    ...(has.artifacts ? ['- `task/artifacts/`: what the work produced so far: designs in `design/`, documents in `docs/`, what the result is checked by in `uat/`, the rest in `misc/`.'] : []),
    '- `task/task.json`: the task as yan keeps it. Read it, never edit it.',
    ...(has.learnings ? ['- `learnings/`: what the user asked to keep beyond one task. Read what touches this work.'] : []),
    ...(has.drafts ? ['- `drafts/`: the user\'s own notes, most about other work. Take one as their thinking, not a decision made.'] : []),
    '',
    '## Deliverables',
    '',
  ];
  if (data.deliverables.length === 0) lines.push('None yet: work out with the user how things must be once this is solved.');
  for (const d of data.deliverables) {
    const box = d.status === 'done' ? '[x]' : d.status === 'abandoned' ? '[-]' : '[ ]';
    lines.push(`- ${box} **${d.id}** ${d.text}${d.status === 'abandoned' ? ` (given up: ${d.reason})` : ''}`);
  }
  lines.push('', '`[x]` is done, `[-]` given up, `[ ]` still to do. The user marks them, not you.');

  if (data.repos.length > 0) {
    lines.push('', '## Repositories', '');
    for (const repo of data.repos) {
      const open = keptIn(repo).filter((b) => branchMark(repo, b) === 'open');
      lines.push(`- ${repo.url}${repo.scope === undefined || repo.scope.length === 0 ? '' : `, in ${repo.scope.map((s) => `\`${s}\``).join(', ')}`}`
        + (open.length === 0 ? ': no branch kept yet, so cut one from the default branch before committing.'
          : `: the work is on ${open.map((b) => `\`${b}\``).join(', ')}. Go on from ${open.length === 1 ? 'it' : 'the one for the app you change'} rather than cutting another.`));
    }
  }

  const resources = byKind(data);
  if (resources.length > 0) {
    lines.push('', '## Resources', '');
    for (const r of resources) lines.push(`- ${r.kind} **${r.name}**: ${r.where}`);
  }

  lines.push(
    '',
    '## Working from this pack',
    '',
    'Read the problem, the deliverables and the log before anything else. Where these notes and the code disagree, the code wins.',
    '',
    'Nothing written into this folder travels back by itself. When you stop, say in one message the user can carry back to the machine the task is kept on:',
    '',
    '- what you did, and where it is: the branch, pushed or not, and any merge request',
    '- each decision made on the way, a line each, as it would read in the log',
    '- which deliverables you take to be met, and what each can be checked by',
    '- what is left, and what waits on the user',
    '',
  );
  return lines.join('\n');
}

interface PackOptions {
  readonly out?: string;
  readonly artifacts: boolean;
  readonly drafts?: boolean;
  readonly json?: boolean;
}

export const command = new Command('pack')
  .description('one task as a zip, to give by hand to an agent that works where the vault is not: its folder, the learnings, and a README for that agent')
  .argument('[task-id]', 'defaults to $YAN_TASK')
  .option('--out <file>', 'where the zip is written, instead of yan-<task-id>.zip in ~/Downloads')
  .option('--no-artifacts', 'leave the task\'s artifacts out, when they are too large to carry')
  .option('--drafts', 'put your drafts in too; they are left out otherwise, being yours and mostly about other work')
  .option('--json', 'what was packed, as JSON')
  .addHelpText(
    'after',
    `
The zip holds one folder, yan-<task-id>/: a README.md for the agent given
it, which has no yan, saying what the task is, its deliverables, its
repositories and branches and its resources, and what to hand back; the
task's folder as it is, under task/; and the vault's learnings. It holds
what the vault would commit, so what .gitignore keeps out stays out, and
no symbolic link and no dot file.

Nothing in the vault changes. The pack is a copy: it leaves this machine
only when you give it to someone, and what the other agent does comes back
the way you carry it. Packing again writes over the last pack.`,
  )
  .action(
    action('yan pack', (given: string | undefined, options: PackOptions) => {
      const task = requiredTask(given, '<task-id>');
      const data = task.read();
      const vault = vaultDir();

      const file = normalizePath(resolve(options.out ?? defaultOut(task.id)));
      // In the vault it would be committed with the next turn, and in a worktree with the code.
      if (isInside(vault, file)) throw YanError.usage('pack_usage', `${file} is inside the vault, where it would be committed with it - write the pack somewhere else`);
      const tree = leasesHeldBy(task.id).find((l) => isInside(l.path, file));
      if (tree !== undefined) throw YanError.usage('pack_usage', `${file} is inside the task's worktree ${tree.path}, where it could be committed with the code - write the pack somewhere else`);
      if (isDirectory(file)) throw YanError.usage('pack_usage', `${file} is a folder - name the zip itself`);

      const root = `yan-${task.id}`;
      const under = `tasks/${task.id}/`;
      const inTask = vaultFiles(vault, under).map((rel) => rel.slice(under.length))
        .filter((rel) => options.artifacts || !rel.startsWith('artifacts/'));
      const learnings = vaultFiles(vault, 'learnings/');
      const drafts = options.drafts === true ? vaultFiles(vault, 'drafts/') : [];

      const problem = ['problem.md', 'brief.md'].find((name) => inTask.includes(name));
      const text = readme(data, {
        problem,
        log: inTask.includes('log.md'),
        artifacts: inTask.some((rel) => rel.startsWith('artifacts/')),
        learnings: learnings.length > 0,
        drafts: drafts.length > 0,
      });
      const entries: ZipEntry[] = [
        { name: `${root}/README.md`, from: Buffer.from(text, 'utf8') },
        ...inTask.map((rel) => ({ name: `${root}/task/${rel}`, from: join(task.dir, rel) })),
        ...[...learnings, ...drafts].map((rel) => ({ name: `${root}/${rel}`, from: join(vault, rel) })),
      ];

      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
      const bytes = writeZip(file, entries);

      if (options.json === true) {
        out(JSON.stringify({ task: task.id, file, bytes, files: entries.map((e) => e.name) }, null, 2));
        return;
      }
      const size = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      out(`${task.id}  packed: ${tildePath(file)}  (${entries.length} files, ${size})`);
      out(`  ${inTask.length} of the task's, ${learnings.length} learning(s)${drafts.length > 0 ? `, ${drafts.length} of your drafts` : ', no drafts'}${options.artifacts ? '' : ', its artifacts left out'}`);
    }),
  );
