import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getJSON, type ArtifactFile, type FileVersion } from '../../lib/api';

/**
 * A Markdown artifact's versions, the newest first: the commits of the
 * vault that changed it. Asked for when first wanted (`wanted`), and again
 * when the file changes, there being a version more.
 */
export function useHistory(task: string, file: ArtifactFile, wanted: boolean): UseQueryResult<FileVersion[]> {
  return useQuery({
    queryKey: ['history', task, file.path, file.sha],
    queryFn: () => getJSON<FileVersion[]>(`/api/artifact/history?task=${encodeURIComponent(task)}&path=${encodeURIComponent(file.path)}`),
    enabled: wanted,
  });
}

/** How a version came about, as its commit says: an edit on this page is named as one, anything else by the commit's own words. */
export const saidOf = (v: FileVersion): string => (/ edited in yan serve$/.test(v.subject) ? 'Edited on the page' : v.subject);
