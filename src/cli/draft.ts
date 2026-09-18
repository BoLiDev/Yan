import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { Command } from 'commander';
import { chosenTask } from './shared/task-id.js';
import { isTty } from './shared/resolve.js';
import { action, out } from './shared/action.js';
import { Drafts, discardIfUntouched, newDraftId, titleTemplate, type DraftSummary } from '../records/drafts/index.js';
import { Task } from '../records/task/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan draft` — `user`'s own notes about one task, kept in
 * `tasks/<id>/artifacts/drafts/` in the format of cli-kit's `draft`.
 *
 *     yan draft [task-id] [--title <words>]   write one, in the editor
 *     yan draft ls [task-id]                  pick one to open; lists when there is no terminal
 *     yan draft cat <draft-id> [task-id]      print one
 *     yan draft search <words...> [task-id]   the ones containing a phrase
 *     yan draft dir [task-id]                 the folder
 *
 * Writing is `user`'s alone: a draft is what they thought outside the
 * conversation, and one written by an agent would be indistinguishable from
 * it. So the paths that open an editor refuse inside a shift and without a
 * terminal, and the reading paths work anywhere.
 */

/** The default number of rows a listing prints. */
const LIST_LIMIT = 20;

/** `2026-09-16 05:15`, in local time. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function taskFor(command: string, given: string | undefined, question: string): Promise<string> {
  const id = await chosenTask('draft', given, { spelled: command, question });
  if (!Task.exists(id)) throw new YanError('task_missing', `no such task: ${id}`);
  return id;
}

/**
 * Refuse unless this is `user` at a keyboard: never inside a shift, and never
 * without a terminal, where an editor would have nobody to type into.
 */
function userOnly(what: string, tty: () => boolean): void {
  const sid = process.env.YAN_SID ?? '';
  if (sid !== '') {
    throw YanError.usage('draft_user_only', `${what} is user's alone: drafts are user's own notes, written at a keyboard, and shift ${sid} only reads them - 'yan draft cat <id>'`);
  }
  if (!tty()) {
    throw YanError.usage('draft_user_only', `${what} needs a terminal: drafts are user's own notes, written at a keyboard - 'yan draft ls --plain' and 'yan draft cat <id>' read them`);
  }
}

// ------------------------------------------------------------------ editor --

/** The command as something spawnable, or null when it is not there. */
function resolveCmd(cmd: string): string | null {
  if (cmd.includes('/') || cmd.includes('\\')) return existsSync(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const full = join(dir, cmd + ext);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        // Not in this directory.
      }
    }
  }
  return null;
}

/** Split a command line into argv, honouring double quotes around a path with spaces. */
function splitCommand(line: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (started) parts.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) parts.push(cur);
  return parts;
}

/** `$DRAFT_EDITOR`, then `$EDITOR`, then `nvim` on PATH. */
function editorCommand(): string[] {
  for (const name of ['DRAFT_EDITOR', 'EDITOR']) {
    const line = (process.env[name] ?? '').trim();
    if (line === '') continue;
    const parts = splitCommand(line);
    const first = parts[0] === undefined ? null : resolveCmd(parts[0]);
    if (first !== null) return [first, ...parts.slice(1)];
    throw new YanError('draft_no_editor', `$${name} is '${line}', and ${parts[0] ?? 'it'} is not on PATH`);
  }
  const nvim = resolveCmd('nvim');
  if (nvim !== null) return [nvim];
  throw new YanError('draft_no_editor', 'no editor: set $DRAFT_EDITOR or $EDITOR, or put nvim on PATH');
}

function openInEditor(path: string, isNew: boolean): void {
  const [cmd = '', ...rest] = editorCommand();
  // A new draft opens at the end, typing.
  const isVim = /^n?vim(\.exe)?$/i.test(basename(cmd));
  const args = [...rest, ...(isNew && isVim ? ['+$', '+startinsert'] : []), path];
  // Windows will not exec a .cmd or .bat directly, so those go through a shell.
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const q = (s: string): string => (/\s/.test(s) ? `"${s}"` : s);
  const r = viaShell
    ? spawnSync([cmd, ...args].map(q).join(' '), { stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error !== undefined) throw new YanError('draft_editor_failed', `could not start ${cmd}: ${r.error.message}`);
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

export interface DraftDeps {
  readonly tty?: () => boolean;
}

/**
 * `yan draft`: a new draft in the editor, kept only if something was written.
 * Exported with its terminal check injectable, since a test has no terminal.
 *
 * @returns the path when the draft was kept, `undefined` when it was discarded.
 */
export function writeDraft(task: string, title: readonly string[], deps: DraftDeps = {}): string | undefined {
  userOnly('writing a draft', deps.tty ?? isTty);
  const drafts = new Drafts(task);
  drafts.ensureDir();
  const path = drafts.pathFor(newDraftId(title));
  const initial = titleTemplate(title);
  if (initial !== '') writeFileSync(path, initial, 'utf8');

  openInEditor(path, true);
  if (discardIfUntouched(path, initial)) {
    out('nothing written, so no draft was kept');
    return undefined;
  }
  out(`saved ${path}`);
  return path;
}

/** Open a draft that already exists; one emptied in the editor is removed. */
function editDraft(path: string): void {
  const before = mtimeOf(path);
  openInEditor(path, false);
  if (discardIfUntouched(path, '')) out(`emptied, so removed ${path}`);
  else if (mtimeOf(path) === before) out(`unchanged ${path}`);
  else out(`saved ${path}`);
}

// ---------------------------------------------------------------- listing --

function positiveInt(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw YanError.usage('draft_usage', `${flag} needs a positive whole number, not '${value}'`);
  return n;
}

function dateOf(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw YanError.usage('draft_usage', `--since needs a date like 2026-09-01, not '${value}'`);
  return d;
}

function printPlain(rows: readonly DraftSummary[]): void {
  for (const d of rows) out(`${d.id}\t${localStamp(d.updated)}\t${d.title}`);
}

interface LsOptions {
  plain?: boolean;
  json?: boolean;
  limit?: string;
  since?: string;
}

const ls = new Command('ls')
  .description('pick a draft to open; with --plain or --json, or without a terminal, list them')
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, or asks when there is a terminal')
  .option('--plain', 'one line per draft: id, updated, title')
  .option('--json', 'the same as JSON, with a preview of each')
  .option('--limit <n>', `at most n drafts (default ${LIST_LIMIT} when listing)`)
  .option('--since <date>', 'only drafts updated at or after this date')
  .action(
    action('draft ls', async (given: string | undefined, options: LsOptions) => {
      const listing = options.plain === true || options.json === true || !isTty();
      const limit = positiveInt('--limit', options.limit) ?? (listing ? LIST_LIMIT : undefined);
      const since = dateOf(options.since);
      if (!listing) userOnly('opening a draft', isTty);

      const task = await taskFor('yan draft ls', given, 'Whose drafts do you want to see?');
      const drafts = new Drafts(task);
      const rows = drafts.list({ ...(limit === undefined ? {} : { limit }), ...(since === undefined ? {} : { since }) });

      if (options.json === true) {
        out(JSON.stringify(rows, null, 2));
        return;
      }
      if (listing) {
        printPlain(rows);
        return;
      }
      if (rows.length === 0) {
        out(`no drafts yet in ${drafts.dir} - 'yan draft ${task}' writes one`);
        return;
      }
      const { chooseDraft } = await import('../ui/prompts.js');
      const id = await chooseDraft(rows.map((d) => ({ ...d, updated: localStamp(d.updated) })), task);
      editDraft(drafts.pathFor(id));
    }),
  );

const cat = new Command('cat')
  .description('print one draft')
  .argument('<draft-id>', "as 'yan draft ls --plain' lists it")
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, or asks when there is a terminal')
  .action(
    action('draft cat', async (id: string, given: string | undefined) => {
      const task = await taskFor('yan draft cat <draft-id>', given, 'Whose draft is it?');
      const drafts = new Drafts(task);
      const draft = drafts.get(id);
      if (draft === undefined) {
        throw new YanError('draft_missing', `no draft ${id} in ${drafts.dir} - 'yan draft ls --plain ${task}' lists them`);
      }
      process.stdout.write(draft.body.endsWith('\n') ? draft.body : `${draft.body}\n`);
    }),
  );

interface SearchOptions {
  json?: boolean;
  limit?: string;
}

const search = new Command('search')
  .description('the drafts containing a phrase, newest first, with a snippet')
  .argument('<words...>', 'the phrase, matched ignoring case; a last word naming a task is the task')
  .option('--json', 'the hits as JSON')
  .option('--limit <n>', `at most n hits (default ${LIST_LIMIT})`)
  .action(
    action('draft search', async (words: string[], options: SearchOptions) => {
      // The task comes last so a session can leave it off; a last word is the
      // task only when a task of that name exists, never by its spelling.
      const last = words.at(-1);
      const given = words.length > 1 && last !== undefined && Task.exists(last) ? last : undefined;
      const phrase = (given === undefined ? words : words.slice(0, -1)).join(' ').trim();
      if (phrase === '') throw YanError.usage('draft_usage', 'search needs a word or a phrase');
      const limit = positiveInt('--limit', options.limit) ?? LIST_LIMIT;

      const task = await taskFor('yan draft search <words...>', given, 'Whose drafts do you want to search?');
      const hits = new Drafts(task).search(phrase, limit);
      if (options.json === true) {
        out(JSON.stringify(hits, null, 2));
        return;
      }
      for (const h of hits) {
        out(`${h.id}\t${localStamp(h.updated)}\t${h.title}`);
        out(`    ${h.snippet}`);
      }
    }),
  );

const dir = new Command('dir')
  .description('print the drafts folder')
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, or asks when there is a terminal')
  .action(
    action('draft dir', async (given: string | undefined) => {
      const task = await taskFor('yan draft dir', given, 'Whose drafts folder do you want?');
      const drafts = new Drafts(task);
      out(drafts.dir);
      if (!existsSync(drafts.dir)) process.stderr.write('draft dir: not there yet - the first draft creates it\n');
    }),
  );

export const command = new Command('draft')
  .description("user's own notes about a task: write, list, read and search them")
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, or asks when there is a terminal')
  .option('--title <words>', 'start the draft with this heading, and put it in the file name')
  .addHelpText(
    'after',
    `
Drafts are user's own notes about one task, written outside the conversation
with yan: ideas, scratch, what to raise next time. They live in
tasks/<id>/artifacts/drafts/<draft-id>.md, in the format of the 'draft' CLI, so
a note moves between the two by moving the file. yan's session start lists
them, and yan reads one with 'yan draft cat' when it looks relevant; neither
yan nor a shift ever writes one, which is why writing refuses without a
terminal and inside a shift.

Every command takes the task last and defaults to $YAN_TASK, so inside a
session 'yan draft cat 2026-09-16_051516' is enough. For search, a last word
that names a task is the task: 'yan draft search parser ideas t127'.

The editor is $DRAFT_EDITOR, else $EDITOR, else nvim. A draft left empty, or
with nothing but its --title, is discarded when the editor exits.`,
  )
  .action(
    action('draft', async (given: string | undefined, options: { title?: string }) => {
      userOnly('writing a draft', isTty);
      const task = await taskFor('yan draft', given, 'Which task is this draft about?');
      const title = (options.title ?? '').split(/\s+/).filter((w) => w !== '');
      writeDraft(task, title);
    }),
  )
  .addCommand(ls)
  .addCommand(cat)
  .addCommand(search)
  .addCommand(dir);
