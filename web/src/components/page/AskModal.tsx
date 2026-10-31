import { useRef, useState } from 'react';
import { useUI, type Ask } from '../../state/ui';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { Input } from '../ui/input';

/**
 * A question over the page, answered by its button or let go. With a
 * `reason`, it also asks for a line, which the button waits for and which
 * the answer is given. Its button has the keyboard, so Enter answers it as
 * the click that asked it would; with a reason, the line has it.
 */
export function AskModal() {
  const ask = useUI((s) => s.ask);
  // The last question asked stays drawn while the box closes.
  const [held, setHeld] = useState<Ask | null>(ask);
  if (ask !== null && ask !== held) setHeld(ask);
  const [given, setGiven] = useState('');
  const action = useRef<HTMLButtonElement>(null);
  const line = useRef<HTMLInputElement>(null);
  const close = (): void => useUI.setState({ ask: null });
  const ready = !held?.reason || given.trim() !== '';
  const answer = (): void => {
    if (held === null || !ready) return;
    close();
    held.then(given.trim());
  };
  return (
    <AlertDialog open={ask !== null} onOpenChange={(open) => { if (!open) close(); }} onOpenChangeComplete={(open) => { if (!open) setGiven(''); }}>
      <AlertDialogContent initialFocus={held?.reason ? line : action}>
        <AlertDialogHeader>
          <AlertDialogTitle>{held?.title}</AlertDialogTitle>
          {held?.sub ? <AlertDialogDescription>{held.sub}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {held?.reason ? (
          <Input ref={line} aria-label={held.reason} placeholder={held.reason} value={given} onChange={(e) => setGiven(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              answer();
            }} />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction ref={action} variant="destructive" disabled={!ready} onClick={answer}>{held?.action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
