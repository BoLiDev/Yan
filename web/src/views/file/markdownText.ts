import type { ArtifactFile } from '../../lib/api';
import { useText, vaultPath } from '../../state/server';
import { useUI } from '../../state/ui';

/**
 * A Markdown artifact's text as the page shows it, in Source and Rendered
 * alike: what is typed and not saved; else what was saved from the page,
 * until the page has fetched the commit that saving made, so the text is
 * never shown as it was before the save; else the file.
 */
export function useMarkdownText(task: string, file: ArtifactFile) {
  const key = vaultPath(task, file.path);
  const loaded = useText(`/blob/${file.sha}`);
  const edit = useUI((s) => s.edits[key]);
  const saved = useUI((s) => s.saved[key]);
  // Saved over this very file, or nothing of the file read yet: what was saved is newer than anything fetched.
  const base = saved !== undefined && (saved.sha === file.sha || loaded.data === undefined) ? saved.text : loaded.data;
  return { key, loaded, edit, base, text: edit?.text ?? base };
}
