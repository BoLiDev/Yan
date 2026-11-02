import { postJSON } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { queryClient } from '../../state/server';
import { toast } from '../../state/ui';

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
