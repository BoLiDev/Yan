import { useEffect, useState } from 'react';
import { postJSON } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { queryClient } from '../../state/server';
import { toast } from '../../state/ui';

/**
 * The task's agent stopped: its herdr tab closed, the shells beside it with
 * it. Asked twice, the first click only turning it to Really stop, which goes
 * back after a few seconds untouched.
 */
export function StopButton({ id }: { id: string }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const back = window.setTimeout(() => setSure(false), 3000);
    return () => window.clearTimeout(back);
  }, [sure]);
  const stop = async (): Promise<void> => {
    setSure(false);
    try {
      await postJSON('/api/terminal/stop', { task: id });
    } catch (err) {
      return void toast(`Could not stop: ${(err as Error).message}`, true);
    }
    void queryClient.invalidateQueries({ queryKey: ['terminals'] });
  };
  return (
    <Button variant={sure ? 'default' : 'ghost'} className={cn('self-center', sure ? 'bg-destructive text-white hover:bg-destructive/90' : 'text-destructive hover:bg-destructive/10 hover:text-destructive')}
      onClick={() => (sure ? void stop() : setSure(true))}>{sure ? 'Really stop' : 'Stop'}</Button>
  );
}

/**
 * The task's agent gone on with, in a new herdr tab: `starting` is told so at
 * once, and told again if the page could not ask. Continue is the page's one
 * thing to do, so it is the primary button.
 */
export function ContinueButton({ id, starting }: { id: string; starting: (on: boolean) => void }) {
  const goOn = async (): Promise<void> => {
    starting(true);
    try {
      await postJSON('/api/launch', { task: id });
    } catch (err) {
      starting(false);
      return void toast(`Could not continue: ${(err as Error).message}`, true);
    }
    void queryClient.invalidateQueries({ queryKey: ['terminals'] });
  };
  return <Button className="self-center" onClick={() => void goOn()}>Continue</Button>;
}
