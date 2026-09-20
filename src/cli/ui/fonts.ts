import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { YanError } from '../../util/error.js';
import { yanHome } from '../../util/home.js';

/**
 * The face the report is drawn in, put next to the page `yan ui` writes.
 *
 * The page names an installed ChillRoundF first and these files second, so
 * `user`, who installed it by hand, sees no change; anyone else gets the same
 * face from `fonts/` beside the page, by a relative URL, so the page still
 * fetches nothing from the network. `templates/ui/fonts/README.md` says what is
 * in the subsets, how they were cut, and why the family is called "Yan Round".
 *
 * A file is rewritten only when it is missing or its bytes differ, so running
 * `yan ui` twice touches nothing and a reader's open page keeps its mtime. The
 * licence travels with the fonts because clause 1 of the OFL says every copy of
 * the font carries the notice.
 */

/** Copied as named, in this order. Everything else in the source directory stays there. */
const FILES = ['yan-round-regular.woff2', 'yan-round-bold.woff2', 'OFL.txt'] as const;

/** The directory name the template's `@font-face` asks for, relative to the page. */
export const FONTS_DIR = 'fonts';

export function fontSourceDir(): string {
  return join(yanHome(), 'templates', 'ui', FONTS_DIR);
}

/** What `copyFonts` did to one file. `same` means it was already byte for byte there. */
export type FontCopy = 'written' | 'same';

/**
 * Put the face in `<pageDir>/fonts/`, and say what each file needed.
 *
 * @throws YanError `ui_fonts` when a file cannot be read from yan's own
 * templates, or cannot be written next to the page — a read-only directory,
 * most likely, and the message names the file and what the filesystem said.
 */
export function copyFonts(pageDir: string): Record<string, FontCopy> {
  const from = fontSourceDir();
  const to = join(pageDir, FONTS_DIR);
  const done: Record<string, FontCopy> = {};

  for (const name of FILES) {
    let wanted: Buffer;
    try {
      wanted = readFileSync(join(from, name));
    } catch (err) {
      throw new YanError('ui_fonts', `no ${name} at ${from}: ${(err as Error).message} - is ${yanHome()} yan's own?`);
    }

    const target = join(to, name);
    let current: Buffer | null;
    try {
      current = readFileSync(target);
    } catch {
      current = null;
    }
    if (current !== null && current.equals(wanted)) {
      done[name] = 'same';
      continue;
    }

    try {
      mkdirSync(to, { recursive: true });
      writeFileSync(target, wanted);
    } catch (err) {
      throw new YanError('ui_fonts', `cannot write ${target}: ${(err as Error).message}`);
    }
    done[name] = 'written';
  }
  return done;
}
