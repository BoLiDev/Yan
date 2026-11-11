import { useRef, useState } from 'react';
import { plural } from '../../lib/format';
import { cn } from '../../lib/utils';
import { addComment, useReview, type Drafted } from '../../state/review';
import { message } from '../../state/ui';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Textarea } from '../ui/textarea';

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
 * reading, Shift+Enter starts a new line, Escape drops it. Nothing is sent
 * anywhere yet: a review goes to the vault whole, from its own box.
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
  const close = (): void => useReview.setState({ drafting: null });
  const keep = (): void => {
    if (held === null || text.trim() === '') return;
    const n = addComment(held, text.trim());
    message.success(`Comment kept · ${plural(n, 'comment')} in this review`);
    close();
  };
  return (
    <Dialog open={drafting !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-[520px]" initialFocus={field}>
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
            keep();
          }} />
        <DialogFooter>
          <span className="mr-auto self-center text-[12px] text-ink-3">Enter keeps it · Shift+Enter for a new line</span>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button disabled={text.trim() === ''} onClick={keep}>Add to review</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
