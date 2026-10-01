/**
 * A remote URL reduced to `host/owner/repo`, so the ssh and https spellings
 * of one repository compare equal.
 */
export function repoKey(url: string): string {
  let s = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  s = s.replace(/^([^/:]+):(?!\d)/, '$1/');
  return s.replace(/^([^/]+)/, (host) => host.toLowerCase().replace(/:\d+$/, ''));
}
