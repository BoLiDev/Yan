import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { learningsDir } from '../../util/vault.js';
import { normalizePath } from '../../util/paths.js';
import { YanError } from '../../util/error.js';
import { byCodePoint } from '../../util/names.js';
import { frontMatter } from './front-matter.js';

/**
 * `learnings/`: what `user` asked to keep beyond one task, one topic per
 * file, named for the topic.
 *
 *   ---
 *   name: Folder trust on a new repository
 *   description: Claude parks on the trust dialog in a new repo's worktrees
 *   ---
 *   the text
 *
 * Indexed by front matter alone, never the text: the index is what a reader
 * scans, and the file is for whoever opens it.
 */

/** One learning as the index lists it. */
export interface Learning {
  /** Absolute, so it can be opened. */
  readonly path: string;
  readonly name: string;
  readonly description: string;
}

/** Every learning, by file name. A missing folder is an empty list. */
export function listLearnings(): Learning[] {
  const dir = learningsDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort(byCodePoint);
  } catch {
    return [];
  }
  const found: Learning[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8').trim();
    } catch {
      continue;
    }
    if (text === '') continue;
    found.push({ path: normalizePath(join(dir, name)), ...frontMatter(name, text) });
  }
  return found;
}

/** A file name for a topic: letters and digits of any script, dashes between. */
export function learningSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Create `learnings/<slug>.md` holding the front matter and nothing else, and
 * return its path. The text is written into the file afterwards.
 *
 * @throws YanError `learn_usage` for an empty or multi-line name or
 *   description, `learn_exists` when a learning of that name is there.
 */
export function addLearning(name: string, description: string): string {
  const title = name.trim();
  const said = description.trim();
  if (title === '' || /[\r\n]/.test(title)) throw YanError.usage('learn_usage', 'a learning needs a name, on one line');
  if (said === '' || /[\r\n]/.test(said)) throw YanError.usage('learn_usage', '--description is required, on one line: when this learning applies');
  const slug = learningSlug(title);
  if (slug === '') throw YanError.usage('learn_usage', `'${title}' has no letters or digits to name a file by`);

  const dir = learningsDir();
  const path = normalizePath(join(dir, `${slug}.md`));
  if (existsSync(path)) {
    throw new YanError('learn_exists', `${path} is already there - edit that file instead`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `---\nname: ${title}\ndescription: ${said}\n---\n\n`);
  return path;
}
