import { repoKey } from '../../util/repo-key.js';

/**
 * Where a repository is seen on the web, told from its remote URL:
 * github.com, and a host with gitlab in its name, which is how most
 * self-hosted ones are called. Any other forge yan cannot tell.
 */
export interface Forge {
  readonly name: 'GitHub' | 'GitLab';
  /** The repository's own page: `https://github.com/owner/repo`. */
  readonly base: string;
}

export function forgeOf(url: string): Forge | undefined {
  const key = repoKey(url);
  const host = key.split('/')[0] ?? '';
  if (host === 'github.com') return { name: 'GitHub', base: `https://${key}` };
  if (host.includes('gitlab')) return { name: 'GitLab', base: `https://${key}` };
  return undefined;
}

/**
 * One of the repository's pages, `tree/main` or `commit/<sha>`: GitLab puts
 * `/-` before them, so they cannot be told from a group's own pages.
 */
export function forgePage(forge: Forge, path: string): string {
  return `${forge.base}${forge.name === 'GitLab' ? '/-' : ''}/${path}`;
}
