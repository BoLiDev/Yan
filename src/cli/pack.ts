import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { action, collect, out } from './shared/action.js';
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
 *
 * What goes is agreed with `user` first, which is yan:pack's to do: the
 * part of the task the other agent takes up and what it has to know for it,
 * written by the agent here as a brief (`--brief`), which the other agent
 * reads before anything else; which of the artifacts it needs
 * (`--artifact`, or none); and the form, a zip, or with `--doc` one
 * Markdown document, the notes in it whole and no file beside it, for an
 * agent that is given text rather than files.
 */

/** Where a pack goes when nobody said: where `user` drags files from, or yan's own folder on a machine with no Downloads. */
function defaultOut(id: string, doc: boolean): string {
  const downloads = join(homedir(), 'Downloads');
  return normalizePath(join(isDirectory(downloads) ? downloads : join(machineDir(), 'packs'), `yan-${id}.${doc ? 'md' : 'zip'}`));
}

/** A note's text, or '' when it cannot be read. */
function textOf(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
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

/** What is in the pack, for the README to name. */
interface Held {
  /** The brief the agent here wrote, when there is one. */
  readonly brief: boolean;
  /** problem.md, or the brief.md of a task from before it; undefined when neither is written. */
  readonly problem: string | undefined;
  readonly log: boolean;
  readonly artifacts: boolean;
  readonly learnings: boolean;
  readonly drafts: boolean;
}

/**
 * What the agent given the pack reads first. It has no yan and no vault, so
 * this says what `yan context` would have: what the task is, which file
 * holds what, the deliverables, the repositories and branches, the
 * resources; and what a skill would have: that the notes here are copies,
 * that there is no vault for it to reach, and what to hand back for `user`
 * to carry home. `where` says where each note is: a file in the zip, or a
 * section of the one document.
 */
function readme(data: TaskData, has: Held, doc: boolean): string {
  const at = (file: string, section: string): string => (doc ? `**${section}**, below` : `\`${file}\``);
  const lines: string[] = [
    `# ${data.id}: ${data.title}`,
    '',
    `One task, packed on ${localDay()} by yan, a CLI that keeps a task's notes from one agent session to the next, for you to go on with. `
      + 'The notes are kept on one machine alone and are shared with nobody: there is no copy of them for you to pull, and nowhere to push one. '
      + `What is ${doc ? 'in this document' : 'in this folder'} is a copy, no \`yan\` command works on it, and all that passes between you and that machine is what the user carries by hand.`,
    '',
    '## What is here',
    '',
    ...(has.brief ? [`- ${at('BRIEF.md', 'Brief')}: what you are asked to do and what you need to know for it, agreed with the user. Start there: the rest is the task it belongs to, and may be wider than what is asked of you.`] : []),
    has.problem === undefined ? '- No problem is written yet.' : `- ${at(`task/${has.problem}`, 'Problem')}: the problem, its background and what is wrong or wanted.`,
    `- ${doc ? '**Deliverables**' : 'The deliverables'}, below: the solution, how things must be once the problem is solved.`,
    ...(has.log ? [`- ${at('task/log.md', 'Log')}: the decisions that steered the work, oldest first. The latest \`paused\` and \`changed\` lines say where it stopped.`] : []),
    ...(has.artifacts ? ['- `task/artifacts/`: what the work produced so far: designs in `design/`, documents in `docs/`, what the result is checked by in `uat/`, the rest in `misc/`.'] : []),
    ...(doc ? [] : ['- `task/task.json`: the task as yan keeps it. Read it, never edit it.']),
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
    `Read ${has.brief ? 'the brief, then ' : ''}the problem, the deliverables and the log before anything else. Where these notes and the code disagree, the code wins.`,
    '',
    'The code is the repositories\' own, pushed as any work on them is. The notes are not: never commit them, or anything copied from them, to a repository, and never put them anywhere else. '
      + 'Do not look for the task\'s vault, clone it or push to it: there is none within your reach, by design.',
    '',
    'Nothing written into this pack travels back by itself. When you stop, say in one message the user can carry back to the machine the task is kept on:',
    '',
    '- what you did, and where it is: the branch, pushed or not, and any merge request',
    '- each decision made on the way, a line each, as it would read in the log',
    '- which deliverables you take to be met, and what each can be checked by',
    '- what is left, and what waits on the user',
    '',
  );
  return lines.join('\n');
}

/** A note set under a heading of the one document, its own headings moved down under it. */
function section(title: string, text: string): string {
  return `## ${title}\n\n${text.replace(/^(#{1,5}) /gm, '##$1 ')}\n`;
}

interface PackOptions {
  readonly out?: string;
  readonly brief?: string;
  readonly doc?: boolean;
  /** False with `--no-artifacts`; which of them go is `artifact`, when any is named. */
  readonly artifacts: boolean;
  readonly artifact?: readonly string[];
  readonly drafts?: boolean;
  readonly json?: boolean;
}

export const command = new Command('pack')
  .description('one task as a zip, or one document, to give by hand to an agent that works where the vault is not - agree with the user what it covers first (yan:pack)')
  .argument('[task-id]', 'defaults to $YAN_TASK')
  .option('--out <file>', 'where it is written, instead of yan-<task-id>.zip (or .md) in ~/Downloads')
  .option('--brief <file>', 'a Markdown file you wrote: what the other agent is asked to do and what it needs to know, as agreed with the user; it reads this first')
  .option('--doc', 'one Markdown document instead of a zip: the brief, the task and its notes whole, and no file beside it')
  .option('--artifact <path>', 'only this of the task\'s artifacts, a file or a folder under artifacts/; repeat for more', collect)
  .option('--no-artifacts', 'leave the task\'s artifacts out')
  .option('--drafts', 'put your drafts in too; they are left out otherwise, being yours and mostly about other work')
  .option('--json', 'what was packed, as JSON')
  .addHelpText(
    'after',
    `
The zip holds one folder, yan-<task-id>/: a README.md for the agent given
it, which has no yan, saying what the task is, its deliverables, its
repositories and branches and its resources, that the notes are shared
with nobody so there is nothing for it to pull or push, and what to say
back; the brief, as BRIEF.md, when --brief names one; the task's folder as
it is, under task/; and the vault's learnings. It holds what the vault
would commit, so what .gitignore keeps out stays out, and no symbolic link
and no dot file.

With --doc there is no zip: one Markdown document holds the brief, what
the README says, the problem and the log, for an agent that is given text
rather than files. No artifact, learning or draft goes with it.

Nothing in the vault changes. The pack is a copy: it leaves this machine
only when you give it to someone, and what the other agent does comes back
the way you carry it. Packing again writes over the last pack.`,
  )
  .action(
    action('yan pack', (given: string | undefined, options: PackOptions) => {
      const task = requiredTask(given, '<task-id>');
      const data = task.read();
      const vault = vaultDir();

      const doc = options.doc === true;
      const file = normalizePath(resolve(options.out ?? defaultOut(task.id, doc)));
      // In the vault it would be committed with the next turn, and in a worktree with the code.
      if (isInside(vault, file)) throw YanError.usage('pack_usage', `${file} is inside the vault, where it would be committed with it - write the pack somewhere else`);
      const tree = leasesHeldBy(task.id).find((l) => isInside(l.path, file));
      if (tree !== undefined) throw YanError.usage('pack_usage', `${file} is inside the task's worktree ${tree.path}, where it could be committed with the code - write the pack somewhere else`);
      if (isDirectory(file)) throw YanError.usage('pack_usage', `${file} is a folder - name the file itself`);

      let brief: string | undefined;
      if (options.brief !== undefined) {
        brief = textOf(resolve(options.brief));
        if (brief === '') throw YanError.usage('pack_usage', `${options.brief} is not there, or is empty - write the brief first, then name it`);
      }

      const root = `yan-${task.id}`;
      const under = `tasks/${task.id}/`;
      // `--artifact a --artifact b` names the ones to take, each a file or a folder; without, all of them, or with --no-artifacts none.
      const wanted = (options.artifact ?? []).map((p) => normalizePath(p).replace(/^(\.\/)?(artifacts\/)?/, '').replace(/\/$/, ''));
      const takes = (rel: string): boolean => {
        if (!rel.startsWith('artifacts/')) return true;
        if (wanted.length === 0) return options.artifacts !== false;
        const inside = rel.slice('artifacts/'.length);
        return wanted.some((w) => inside === w || inside.startsWith(`${w}/`));
      };
      const all = vaultFiles(vault, under).map((rel) => rel.slice(under.length));
      for (const w of wanted) {
        if (!all.some((rel) => rel === `artifacts/${w}` || rel.startsWith(`artifacts/${w}/`))) throw YanError.usage('pack_usage', `the task has no artifact ${w} - 'yan context' lists them`);
      }
      const inTask = doc ? all.filter((rel) => !rel.startsWith('artifacts/')) : all.filter(takes);
      const learnings = doc ? [] : vaultFiles(vault, 'learnings/');
      const drafts = !doc && options.drafts === true ? vaultFiles(vault, 'drafts/') : [];

      const problem = ['problem.md', 'brief.md'].find((name) => inTask.includes(name));
      const text = readme(data, {
        brief: brief !== undefined,
        problem,
        log: inTask.includes('log.md'),
        artifacts: inTask.some((rel) => rel.startsWith('artifacts/')),
        learnings: learnings.length > 0,
        drafts: drafts.length > 0,
      }, doc);
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });

      if (doc) {
        const whole = [
          text,
          ...(brief === undefined ? [] : [section('Brief', brief)]),
          ...(problem === undefined ? [] : [section('Problem', textOf(join(task.dir, problem)))]),
          ...(inTask.includes('log.md') ? [section('Log', textOf(join(task.dir, 'log.md')))] : []),
        ].join('\n');
        writeFileSync(file, whole);
        if (options.json === true) {
          out(JSON.stringify({ task: task.id, file, bytes: Buffer.byteLength(whole), files: [] }, null, 2));
          return;
        }
        out(`${task.id}  packed as one document: ${tildePath(file)}`);
        out(`  ${brief === undefined ? 'no brief, ' : 'the brief, '}the task, its problem and its log; no artifact goes with a document`);
        return;
      }

      const entries: ZipEntry[] = [
        { name: `${root}/README.md`, from: Buffer.from(text, 'utf8') },
        ...(brief === undefined ? [] : [{ name: `${root}/BRIEF.md`, from: Buffer.from(`${brief}\n`, 'utf8') }]),
        ...inTask.map((rel) => ({ name: `${root}/task/${rel}`, from: join(task.dir, rel) })),
        ...[...learnings, ...drafts].map((rel) => ({ name: `${root}/${rel}`, from: join(vault, rel) })),
      ];
      const bytes = writeZip(file, entries);

      if (options.json === true) {
        out(JSON.stringify({ task: task.id, file, bytes, files: entries.map((e) => e.name) }, null, 2));
        return;
      }
      const size = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      const left = all.filter((rel) => rel.startsWith('artifacts/')).length - inTask.filter((rel) => rel.startsWith('artifacts/')).length;
      out(`${task.id}  packed: ${tildePath(file)}  (${entries.length} files, ${size})`);
      out(`  ${brief === undefined ? 'no brief' : 'the brief'}, ${inTask.length} of the task's, ${learnings.length} learning(s)${drafts.length > 0 ? `, ${drafts.length} of your drafts` : ', no drafts'}${left > 0 ? `, ${left} artifact(s) left out` : ''}`);
    }),
  );
