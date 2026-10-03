import { repoWithUrl } from '../../records/repos/index.js';
import { repoKey } from '../../util/repo-key.js';

/** What a repository is called on screen: its registered name, or the last part of its URL. */
export function repoName(url: string): string {
  return repoWithUrl(url)?.name ?? repoKey(url).split('/').pop() ?? url;
}
