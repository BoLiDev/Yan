// Picking a new task's repositories, and their packages, as antd's Cascader picks several.

import { matchText } from './find';

/** A repository a new task may work in, as serve offers it, with its packages when it has several. */
export interface RepoOption {
  readonly name: string;
  readonly packages: readonly string[];
}

/** Each repository picked, with the packages it is about: `[]` for the whole of it. */
export type Picked = Readonly<Record<string, readonly string[]>>;

/** How a repository stands in what is picked: all of it, some of its packages, or none. */
export type Checked = 'on' | 'some' | 'off';

export function stateOf(picked: Picked, r: RepoOption): Checked {
  const own = picked[r.name];
  return own === undefined ? 'off' : own.length === 0 ? 'on' : 'some';
}

export function packageOn(picked: Picked, r: RepoOption, pkg: string): boolean {
  const own = picked[r.name];
  return own !== undefined && (own.length === 0 || own.includes(pkg));
}

/** A repository ticked is all of it, and ticked again none; a part-ticked one ticked is all of it. */
export function tickRepo(picked: Picked, r: RepoOption): Picked {
  const { [r.name]: was, ...rest } = picked;
  return was !== undefined && was.length === 0 ? rest : { ...picked, [r.name]: [] };
}

/** A package ticked narrows its repository to the packages ticked; every one of them ticked is the whole of it. */
export function tickPackage(picked: Picked, r: RepoOption, pkg: string): Picked {
  const was = picked[r.name];
  const now = was === undefined ? [pkg] : was.length === 0 ? r.packages.filter((x) => x !== pkg) : was.includes(pkg) ? was.filter((x) => x !== pkg) : [...was, pkg];
  const { [r.name]: _, ...rest } = picked;
  if (now.length === 0) return rest;
  return { ...picked, [r.name]: now.length === r.packages.length ? [] : now };
}

/** One thing a search found: a repository, or one of its packages by its path, `web / packages/core`. */
export interface Hit {
  readonly repo: RepoOption;
  readonly pkg?: string;
  readonly label: string;
  readonly marks: readonly (readonly [number, number])[];
}

/**
 * What `query` finds among the repositories and their packages, best first,
 * as ⌘K finds a task: every word typed matching somewhere in a repository's
 * name, or in a package's path, its repository's name with it, so `web core`
 * finds `web / packages/core`. Ties keep the list's order.
 */
export function findPicks(repos: readonly RepoOption[], query: string): Hit[] {
  const found: (Hit & { score: number; at: number })[] = [];
  for (const repo of repos) {
    const own = matchText(repo.name, query);
    if (own !== undefined) found.push({ repo, label: repo.name, marks: own.marks, score: own.score, at: found.length });
    for (const pkg of repo.packages) {
      const label = `${repo.name} / ${pkg}`;
      const m = matchText(label, query);
      if (m !== undefined) found.push({ repo, pkg, label, marks: m.marks, score: m.score, at: found.length });
    }
  }
  return found.sort((a, b) => b.score - a.score || a.at - b.at).map(({ repo, pkg, label, marks }) => ({ repo, ...(pkg === undefined ? {} : { pkg }), label, marks }));
}
