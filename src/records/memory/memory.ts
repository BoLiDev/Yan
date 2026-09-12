import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { memDir, skillsDir } from '../../util/vault.js';
import { machineSkillsDir } from '../../util/machine.js';
import { frontMatter } from './front-matter.js';
import type { Indexed } from './types.js';

/**
 * The two directories of markdown yan reads as an index rather than as prose:
 * `skills/`, which is `user` speaking in advance about this environment, and
 * `mem/learnings/`, which is what earlier work found out the hard way.
 *
 * Both are indexed the same way — path, name and description, never the text —
 * because both are read the same way: a session start lists them, and a
 * problem that matches one opens it.
 */

/**
 * Index the `*.md` files in one directory. An unreadable directory or file is
 * skipped, so a missing vault costs an empty list rather than a failed start.
 */
function indexOf(dir: string, label: string): Indexed[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const found: Indexed[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8').trim();
    } catch {
      continue;
    }
    if (text === '') continue;
    found.push({ path: `${label}/${name}`, ...frontMatter(name, text) });
  }
  return found;
}

/** Every skill, the vault's before this machine's. */
export function readSkills(): Indexed[] {
  let fromVault: Indexed[] = [];
  try {
    fromVault = indexOf(skillsDir(), 'skills');
  } catch {
    fromVault = [];
  }
  return [...fromVault, ...indexOf(machineSkillsDir(), 'machine skills')];
}

/** The index of `mem/learnings/`. */
export function readLearnings(): Indexed[] {
  try {
    return indexOf(join(memDir(), 'learnings'), 'mem/learnings');
  } catch {
    return [];
  }
}
