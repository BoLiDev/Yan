import { useEffect } from 'react';
import { baseName } from '../lib/files';
import { usePageKeys } from '../lib/modal';
import { link } from '../lib/route';
import { Icon } from '../components/Icon';
import { Empty } from '../components/page';
import { FrameReview } from '../components/review/FrameReview';
import { fileUrl, useIndex, useTask, vaultPath } from '../state/server';
import { useUI } from '../state/ui';

/**
 * A page an agent wrote, with the whole window to itself: what Full size
 * gives for one, in the tab it was being looked at in. It is still yan's
 * page that shows it, in a frame, and nothing else of yan's is drawn but
 * the way back, so a design is looked at at its full size and is still
 * reviewed: a right click in it comments on it, into the task's review, as
 * in the file's own view. Escape, or the button at its corner, goes back to
 * where it was opened from; opened by its own address, to the file.
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
  const close = (): void => {
    // Back to where it was opened from, so the tab's own Back does not come here again; else to the file.
    const from = useUI.getState().fullFrom;
    useUI.setState({ fullFrom: null });
    if (from !== null) history.back();
    else location.replace(link.file(task, path));
  };
  usePageKeys((e) => {
    if (e.key !== 'Escape') return false;
    close();
    return true;
  });
  if (error && !index) return <Empty title="Can't reach yan serve">{String(error.message)}</Empty>;
  if (!index || !d) return <Empty>Loading…</Empty>;
  if (!d.files.some((f) => f.path === path)) return <Empty title="Not there any more">{`${path} is not in ${task}'s artifacts at the commit being shown.`}</Empty>;
  return (
    <>
      <FrameReview task={task} path={`artifacts/${path}`} onEscape={close}>
        <iframe src={`${fileUrl(vaultPath(task, path))}?review`} title="Page" className="block size-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
      </FrameReview>
      {/* Over the page's corner, faint until it is reached for, so it takes as little of the design as it can. */}
      <button type="button" aria-label="Back to the task" title="Back to the task (Esc)" onClick={close}
        className="fixed top-3 right-3 z-40 flex size-8 cursor-pointer items-center justify-center rounded-full bg-black/45 text-white opacity-45 shadow-md backdrop-blur-sm transition-opacity hover:opacity-100 focus-visible:opacity-100">
        <Icon name="shrink" size={15} />
      </button>
    </>
  );
}
