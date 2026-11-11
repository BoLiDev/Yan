import { useState } from 'react';
import { postJSON, type ReviewAsked, type ReviewSaved } from '../../lib/api';
import { plural } from '../../lib/format';
import { go, link, useRoute } from '../../lib/route';
import { goesOn } from '../../lib/stops';
import { dropComment, reviewWritten, rewordComment, setSummary, useComments, useReview, type Kept } from '../../state/review';
import { onStatus, queryClient, useIndex } from '../../state/server';
import { copyText, message, toast } from '../../state/ui';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Spinner } from '../ui/spinner';
import { Textarea } from '../ui/textarea';
import { Quote } from './CommentBox';

/** A review's box down the right of the page, the page behind it still there to be read around. */
const SHEET = 'top-0 right-0 left-auto flex h-full max-h-screen w-[460px] translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-[calc(100%-2rem)]';

/** One comment in the review: where it is, which goes back there, what it is about, and its words, rewritten in place. */
function Row({ task, c, n }: { task: string; c: Kept; n: number }) {
  return (
    <li className="flex flex-col gap-1.5 border-b border-sunken px-4 py-3">
      <div className="flex items-start gap-2">
        <a className="min-w-0 flex-auto text-[12.5px] leading-[18px] font-medium text-ink-2 wrap-anywhere hover:text-brand" href={c.href}
          onClick={() => useReview.setState({ open: null })}>{`${n}. ${c.where}`}</a>
        <Button variant="ghost" size="icon-xs" className="text-ink-3" aria-label={`Delete comment ${n}`} title="Delete this comment" onClick={() => dropComment(task, c.id)}>
          <Icon name="trash" size={13} />
        </Button>
      </div>
      <Quote c={c} className="line-clamp-3" />
      <Textarea aria-label={`Comment ${n}`} className="min-h-0 border-transparent px-0 py-0 text-[13.5px] leading-[21px] shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-[13.5px]"
        value={c.text} onChange={(e) => rewordComment(task, c.id, e.target.value)} />
    </li>
  );
}

/**
 * Write the task's review to the vault, which serve commits and pushes,
 * and, asked to (`send`), have its agent on this machine take it up, as
 * Done has it close the task: typed into the agent running here, or one
 * started on it. A push that failed is said, the review kept here and
 * pushed later; an agent that could not be asked is said too, the review
 * written all the same. Whether the box may close.
 */
async function finish(task: string, send: boolean): Promise<boolean> {
  const { comments, summary } = useReview.getState();
  const asked: ReviewAsked = {
    task,
    summary: (summary[task] ?? '').trim(),
    comments: (comments[task] ?? []).filter((c) => c.text.trim() !== '').map((c) => ({ where: c.where, quote: c.quote, text: c.text.trim(), ...(c.code ? { code: true } : {}) })),
  };
  let saved: ReviewSaved;
  try {
    saved = await postJSON<ReviewSaved>('/api/review', asked);
  } catch (err) {
    toast(`The review was not saved: ${(err as Error).message}`, true);
    return false;
  }
  reviewWritten(task, { path: saved.path, comments: asked.comments.length });
  void onStatus(saved.status);
  if (saved.warning) toast(`The review is saved here, but the push failed: ${saved.warning}`, true);
  else message.success('Review saved and pushed');
  if (!send) return false;
  return sendToAgent(task);
}

/** The agent on this machine asked to take up the review last written; whether it was. */
async function sendToAgent(task: string): Promise<boolean> {
  try {
    await postJSON('/api/task/review', { task });
  } catch (err) {
    toast(`The review is saved, but its agent was not asked: ${(err as Error).message}`, true);
    return false;
  }
  await queryClient.invalidateQueries({ queryKey: ['terminals'] });
  go(link.terminal(task));
  return true;
}

/**
 * The review being gathered on the task the page is at: a button at the
 * foot of the page while it holds a comment, saying how many, and the box
 * it opens, the comments in the order they were made, each to be reworded
 * or dropped, with a word on it all under them. Finish writes it to the
 * vault, where an agent anywhere reads it; Send to agent does, then asks the
 * task's agent on this machine to take it up. Once written, the box says
 * where, for an agent elsewhere to be pointed at.
 */
export function ReviewPanel() {
  const r = useRoute();
  const task = r.view === 'task' || (r.view === 'latest' && r.id) ? r.id : undefined;
  const comments = useComments(task);
  const open = useReview((s) => s.open);
  const summary = useReview((s) => (task ? s.summary[task] ?? '' : ''));
  const written = useReview((s) => (task ? s.written[task] : undefined));
  const { data: index } = useIndex();
  const [busy, setBusy] = useState<'finish' | 'send' | null>(null);
  if (task === undefined) return null;
  const t = index?.tasks.find((x) => x.id === task);
  const local = t !== undefined && goesOn(t);
  const close = (): void => useReview.setState((s) => {
    const { [task]: _w, ...rest } = s.written;
    return { open: null, written: rest };
  });
  const run = async (send: boolean, how: () => Promise<boolean>): Promise<void> => {
    setBusy(send ? 'send' : 'finish');
    try {
      if (await how()) close();
    } finally {
      setBusy(null);
    }
  };
  const ready = comments.some((c) => c.text.trim() !== '') || summary.trim() !== '';
  const done = written !== undefined && comments.length === 0;

  return (
    <>
      {comments.length > 0 && open !== task ? (
        <Button className="fixed right-6 bottom-6 z-40 rounded-full px-4 shadow-lg" onClick={() => useReview.setState({ open: task })}>
          {`Review · ${plural(comments.length, 'comment')}`}
        </Button>
      ) : null}
      <Dialog open={open === task} onOpenChange={(o) => { if (!o && busy === null) close(); }}>
        <DialogContent className={SHEET}>
          <DialogHeader className="border-b border-sunken px-4 py-3.5">
            <DialogTitle>{`Review of ${task}`}</DialogTitle>
            <DialogDescription>
              {done ? 'Written to the vault.' : `${plural(comments.length, 'comment')}, kept in this browser until the review is finished.`}
            </DialogDescription>
          </DialogHeader>
          {done ? (
            <div className="flex flex-auto flex-col gap-3 px-4 py-4 text-[13.5px] leading-[21px]">
              <p>{`${plural(written.comments, 'comment')} saved as`}</p>
              <code className="rounded-[6px] bg-sunken px-2 py-1.5 font-mono text-[12.5px] wrap-anywhere">{written.path}</code>
              <p className="text-ink-3">An agent anywhere reads it with <code className="font-mono text-[12.5px]">yan review</code>, or the yan:review skill.</p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => copyText(written.path, 'Copied the path', 'Copy the path of the review')}>Copy path</Button>
                {local ? (
                  <Button disabled={busy !== null} aria-busy={busy === 'send'} onClick={() => void run(true, () => sendToAgent(task))}>
                    {busy === 'send' ? <Spinner aria-hidden /> : null}Send to agent
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <ol className="min-h-0 flex-auto overflow-y-auto">
                {comments.map((c, i) => <Row key={c.id} task={task} c={c} n={i + 1} />)}
              </ol>
              <div className="flex flex-none flex-col gap-3 border-t bg-muted/50 px-4 py-3.5">
                <Textarea aria-label="Overall" placeholder="A word on it all, if there is one" className="max-h-40 min-h-16 bg-card" value={summary}
                  onChange={(e) => setSummary(task, e.target.value)} />
                <div className="flex justify-end gap-2">
                  <Button variant="outline" disabled={!ready || busy !== null} aria-busy={busy === 'finish'} title="Write the review to the vault and push it"
                    onClick={() => void run(false, () => finish(task, false))}>
                    {busy === 'finish' ? <Spinner aria-hidden /> : null}Finish
                  </Button>
                  {local ? (
                    <Button disabled={!ready || busy !== null} aria-busy={busy === 'send'} title="Write and push the review, then ask the task's agent on this machine to take it up"
                      onClick={() => void run(true, () => finish(task, true))}>
                      {busy === 'send' ? <Spinner aria-hidden /> : null}Send to agent
                    </Button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
