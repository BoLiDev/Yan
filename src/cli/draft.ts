import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Command } from 'commander';
import { isTty } from './shared/tty.js';
import { action, out } from './shared/action.js';
import { saveVault } from './shared/vault-push.js';
import { Drafts, discardIfUntouched, newDraftId, picturesFrom, titleTemplate, type DraftSummary } from '../records/drafts/index.js';
import { YanError } from '../util/error.js';
import { localStamp } from '../util/time.js';
import { vaultDir } from '../util/vault.js';
import { which } from '../util/which.js';

/**
 * `yan draft` — `user`'s own notes, the vault's rather than one task's, so
 * every agent on every task reads them; kept in `drafts/` in the format of
 * cli-kit's `draft`, with those once kept per task read where they are.
 *
 *     yan draft [--title <words>]   write one, in the editor
 *     yan draft ls                  pick one to open; lists when there is no terminal
 *     yan draft cat <draft-id>      print one
 *     yan draft search <words...>   the ones containing a phrase
 *     yan draft dir                 the folder
 *
 * Writing is `user`'s alone: a draft is what they thought outside the
 * conversation, and one written by an agent would be indistinguishable from
 * it. So the paths that open an editor refuse without a terminal, and the
 * reading paths work anywhere. A draft written or changed is committed and
 * pushed at once, so the agents on other machines, and yan serve's page,
 * which shows the vault as committed, have it.
 */

/** The default number of rows a listing prints. */
const LIST_LIMIT = 20;

/** Commit and push the vault with what the editor left; a push that fails leaves it committed here, and says so. */
function save(message: string): void {
  try {
    saveVault(vaultDir(), message);
  } catch (err) {
    process.stderr.write(`kept here, but the vault was not pushed: ${(err as Error).message}\n`);
  }
}

/**
 * Refuse unless this is `user` at a keyboard: never without a terminal, where
 * an editor would have nobody to type into.
 */
function userOnly(what: string, tty: () => boolean): void {
  if (!tty()) {
    throw YanError.usage('draft_user_only', `${what} needs a terminal: drafts are user's own notes, written at a keyboard - 'yan draft ls --plain' and 'yan draft cat <id>' read them`);
  }
}

// ------------------------------------------------------------------ editor --

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
    const first = parts[0] === undefined ? undefined : which(parts[0]);
    if (first !== undefined) return [first, ...parts.slice(1)];
    throw new YanError('draft_no_editor', `$${name} is '${line}', and ${parts[0] ?? 'it'} is not on PATH`);
  }
  const nvim = which('nvim');
  if (nvim !== undefined) return [nvim];
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

interface DraftDeps {
  readonly tty?: () => boolean;
}

/**
 * `yan draft`: a new draft in the editor, kept only if something was written.
 * Exported with its terminal check injectable, since a test has no terminal.
 *
 * @returns the path when the draft was kept, `undefined` when it was discarded.
 */
export function writeDraft(title: readonly string[], deps: DraftDeps = {}): string | undefined {
  userOnly('writing a draft', deps.tty ?? isTty);
  const drafts = new Drafts();
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
  save(`draft ${basename(path, '.md')} written`);
  return path;
}

/** Open a draft that already exists; one emptied in the editor is removed. */
function editDraft(path: string): void {
  const before = mtimeOf(path);
  const id = basename(path, '.md');
  openInEditor(path, false);
  if (discardIfUntouched(path, '')) {
    out(`emptied, so removed ${path}`);
    save(`draft ${id} removed`);
  } else if (mtimeOf(path) === before) out(`unchanged ${path}`);
  else {
    out(`saved ${path}`);
    save(`draft ${id} edited`);
  }
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
  for (const d of rows) out(`${d.id}\t${localStamp(new Date(d.updated))}\t${d.title}`);
}

interface LsOptions {
  plain?: boolean;
  json?: boolean;
  limit?: string;
  since?: string;
}

const ls = new Command('ls')
  .description('pick a draft to open; with --plain or --json, or without a terminal, list them')
  .option('--plain', 'one line per draft: id, updated, title')
  .option('--json', 'the same as JSON, with a preview of each')
  .option('--limit <n>', `at most n drafts (default ${LIST_LIMIT} when listing)`)
  .option('--since <date>', 'only drafts updated at or after this date')
  .action(
    action('yan draft ls', async (options: LsOptions) => {
      const listing = options.plain === true || options.json === true || !isTty();
      const limit = positiveInt('--limit', options.limit) ?? (listing ? LIST_LIMIT : undefined);
      const since = dateOf(options.since);
      if (!listing) userOnly('opening a draft', isTty);

      const drafts = new Drafts();
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
        out(`no drafts yet in ${drafts.dir} - 'yan draft' writes one`);
        return;
      }
      const { chooseDraft } = await import('../ui/prompts.js');
      const id = await chooseDraft(rows.map((d) => ({ ...d, updated: localStamp(new Date(d.updated)) })));
      editDraft(drafts.pathOf(id) ?? drafts.pathFor(id));
    }),
  );

const cat = new Command('cat')
  .description('print one draft, its pictures named by where they are on this machine')
  .argument('<draft-id>', "as 'yan draft ls --plain' lists it")
  .action(
    action('yan draft cat', async (id: string) => {
      const drafts = new Drafts();
      const draft = drafts.get(id);
      if (draft === undefined) {
        throw new YanError('draft_missing', `no draft ${id} in ${drafts.dir} - 'yan draft ls --plain' lists them`);
      }
      // Its pictures named by where they are here, so a reader outside the vault, an agent, can open them.
      const body = picturesFrom(draft.body, draft.path);
      process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
    }),
  );

interface SearchOptions {
  json?: boolean;
  limit?: string;
}

const search = new Command('search')
  .description('the drafts containing a phrase, newest first, with a snippet')
  .argument('<words...>', 'the phrase, matched ignoring case')
  .option('--json', 'the hits as JSON')
  .option('--limit <n>', `at most n hits (default ${LIST_LIMIT})`)
  .action(
    action('yan draft search', async (words: string[], options: SearchOptions) => {
      const phrase = words.join(' ').trim();
      if (phrase === '') throw YanError.usage('draft_usage', 'search needs a word or a phrase');
      const limit = positiveInt('--limit', options.limit) ?? LIST_LIMIT;
      const hits = new Drafts().search(phrase, limit);
      if (options.json === true) {
        out(JSON.stringify(hits, null, 2));
        return;
      }
      for (const h of hits) {
        out(`${h.id}\t${localStamp(new Date(h.updated))}\t${h.title}`);
        out(`    ${h.snippet}`);
      }
    }),
  );

const dir = new Command('dir')
  .description('print the drafts folder')
  .action(
    action('yan draft dir', async () => {
      const drafts = new Drafts();
      out(drafts.dir);
      if (!existsSync(drafts.dir)) process.stderr.write('draft dir: not there yet - the first draft creates it\n');
    }),
  );

export const command = new Command('draft')
  .description("the user's own notes, which every task shares: write, list, read and search them; an agent reads them, never writes one")
  .option('--title <words>', 'start the draft with this heading, and put it in the file name')
  .addHelpText(
    'after',
    `
Drafts are the user's own notes, written outside the conversation: ideas,
scratch, what to raise next time. They are the vault's, not one task's, so
every agent on every task can read them: 'yan context' lists the newest, and
an agent reads one with 'yan draft cat' when its title touches the work. An
agent never writes one, which is why writing refuses without a terminal; the
user writes them here or on yan serve's page.

They live in drafts/<draft-id>.md at the top of the vault, in the format of
the 'draft' CLI, so a note moves between the two by moving the file, and
the pictures pasted into one on the page in drafts/<draft-id>/, which goes
with it. Drafts once kept in a task's own drafts/ folder are read where
they are. A draft written or changed here is committed and pushed at once.

The editor is $DRAFT_EDITOR, else $EDITOR, else nvim. A draft left empty, or
with nothing but its --title, is discarded when the editor exits.`,
  )
  .action(
    action('yan draft', async (options: { title?: string }) => {
      const title = (options.title ?? '').split(/\s+/).filter((w) => w !== '');
      writeDraft(title);
    }),
  )
  .addCommand(ls)
  .addCommand(cat)
  .addCommand(search)
  .addCommand(dir);
