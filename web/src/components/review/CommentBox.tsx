import { useRef, useState } from 'react';
import { MOD, plural } from '../../lib/format';
import { goesOn } from '../../lib/stops';
import { cn } from '../../lib/utils';
import { addComment, useReview, type Drafted } from '../../state/review';
import { useIndex } from '../../state/server';
import { message } from '../../state/ui';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Spinner } from '../ui/spinner';
import { Textarea } from '../ui/textarea';
import { askAgent, writeReview } from './send';

/** What a comment is about, as it was selected: a few lines of it, code in code's face. */
export function Quote({ c, className }: { c: { quote: string; code?: boolean }; className?: string }) {
  if (c.quote.trim() === '') return null;
  return (
    <div className={cn('line-clamp-4 border-l-3 border-border pl-2.5 text-[12.5px] leading-[19px] whitespace-pre-wrap text-ink-3 wrap-anywhere', c.code && 'font-mono text-[12px]', className)}>
      {c.quote.trim()}
    </div>
  );
}

/**
 * The box a comment is written in, over the page, opened from what was
 * selected: Enter keeps it in the task's review and goes back to the
 * reading, Shift+Enter starts a new line, Escape drops it. Kept, nothing is
 * sent anywhere yet: a review goes to the vault whole, from its own box.
 *
 * Or the comment goes to the task's agent on this machine at once, by
 * itself, with ⌘Enter or its button: one thing to say now, not worth
 * gathering a review for. It is written to the vault as a review of one
 * comment, as any review is, and the agent asked to take it up; what has
 * been gathered meanwhile stays gathered, and the reading stays where it is.
 */
export function CommentBox() {
  const drafting = useReview((s) => s.drafting);
  // The last one stays drawn while the box closes, and each starts with nothing written.
  const [held, setHeld] = useState<Drafted | null>(drafting);
  const [text, setText] = useState('');
  if (drafting !== null && drafting !== held) {
    setHeld(drafting);
    setText('');
  }
  const field = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const { data: index } = useIndex();
  const t = index?.tasks.find((x) => x.id === held?.task);
  // An agent can be asked for a task that goes on: one closed or paused has none to ask, and none is started on it.
  const local = t !== undefined && goesOn(t);
  const close = (): void => useReview.setState({ drafting: null });
  const send = async (): Promise<void> => {
    if (held === null || text.trim() === '' || sending || !local) return;
    setSending(true);
    try {
      const saved = await writeReview({ task: held.task, summary: '', comments: [{ where: held.where, quote: held.quote, text: text.trim(), ...(held.code ? { code: true } : {}) }] });
      // Not written, it stays here to be sent again or kept; written, it is the agent's to read whether or not it could be asked now.
      if (saved === null) return;
      if (await askAgent(held.task)) message.success('Sent to the agent');
      close();
    } finally {
      setSending(false);
    }
  };
  const keep = (): void => {
    if (held === null || text.trim() === '') return;
    const n = addComment(held, text.trim());
    message.success(`Comment kept · ${plural(n, 'comment')} in this review`);
    close();
  };
  return (
    <Dialog open={drafting !== null} onOpenChange={(open) => { if (!open && !sending) close(); }}>
      <DialogContent className="sm:max-w-[580px]" initialFocus={field}>
        <DialogHeader>
          <DialogTitle>Comment</DialogTitle>
          <DialogDescription className="wrap-anywhere">{held?.where}</DialogDescription>
        </DialogHeader>
        {held ? <Quote c={held} /> : null}
        <Textarea ref={field} aria-label="Comment" placeholder="What do you make of it?" className="max-h-[40vh] min-h-24" value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) void send();
            else keep();
          }} />
        <DialogFooter>
          <span className="mr-auto self-center text-[12px] text-ink-3">{`Enter adds it${local ? ` · ${MOD}Enter sends it now` : ''} · Shift+Enter for a new line`}</span>
          <Button variant="ghost" disabled={sending} onClick={close}>Cancel</Button>
          {local ? (
            <Button variant="ghost" className="bg-card hover:bg-card/60" disabled={text.trim() === '' || sending} aria-busy={sending} title="Send this comment alone to the task's agent on this machine, now" onClick={() => void send()}>
              {sending ? <Spinner aria-hidden /> : null}Send to agent
            </Button>
          ) : null}
          <Button disabled={text.trim() === '' || sending} onClick={keep}>Add to review</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
