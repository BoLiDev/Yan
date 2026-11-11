import { useEffect } from 'react';
import { baseName } from '../lib/files';
import { Empty } from '../components/page';
import { FrameReview } from '../components/review/FrameReview';
import { fileUrl, useIndex, useTask, vaultPath } from '../state/server';

/**
 * A page an agent wrote, with the whole window to itself: what Open in a
 * new tab gives for one. It is still yan's page that shows it, in a frame,
 * and nothing else of yan's is drawn, so a design is looked at at its full
 * size and is still reviewed: a right click in it comments on it, into the
 * task's review, as in the file's own view. Opened as the file itself, on
 * the files port, it would be out of reach of the review, which is this
 * origin's.
 */
export function FullPage({ task, path }: { task: string; path: string }) {
  const { data: index, error } = useIndex();
  const { data: d } = useTask(index ? task : undefined);
  useEffect(() => {
    const was = document.title;
    document.title = `${baseName(path)} · ${task}`;
    return () => {
      document.title = was;
    };
  }, [task, path]);
  if (error && !index) return <Empty title="Can't reach yan serve">{String(error.message)}</Empty>;
  if (!index || !d) return <Empty>Loading…</Empty>;
  if (!d.files.some((f) => f.path === path)) return <Empty title="Not there any more">{`${path} is not in ${task}'s artifacts at the commit being shown.`}</Empty>;
  return (
    <FrameReview task={task} path={`artifacts/${path}`}>
      <iframe src={`${fileUrl(vaultPath(task, path))}?review`} title="Page" className="block size-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
    </FrameReview>
  );
}
