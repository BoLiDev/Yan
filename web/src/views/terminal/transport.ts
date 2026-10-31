import { postJSON } from '../../lib/api';
import { queryClient } from '../../state/server';
import { toast } from '../../state/ui';

export type Input = { keys: string[] } | { text: string } | { paste: string; enter: boolean } | { wheel: number; col: number; row: number } | { cols: number; rows: number };

let sending: Promise<void> = Promise.resolve();

/**
 * What is typed, sent to a pane of the agent's tab: keys by herdr's names,
 * bytes as a terminal sends them, or a paste. One after another, each once
 * the one before is in, so a Backspace never overtakes the letter it takes
 * back.
 */
export function send(task: string, pane: string, what: Input): void {
  sending = sending.then(() => postJSON('/api/terminal/input', { task, pane, ...what }).then(() => undefined, (err: Error) => toast(`Not sent: ${err.message}`, true)));
}

/** A pane split off, or closed, through herdr; the tab as herdr then has it is asked for at once. */
export async function reshape(what: 'split' | 'close', body: Record<string, unknown>): Promise<{ pane?: string } | undefined> {
  const failed = what === 'split' ? 'Could not split the pane' : 'Could not close the pane';
  try {
    return await postJSON<{ pane?: string }>(`/api/terminal/${what}`, body);
  } catch (err) {
    toast(`${failed}: ${(err as Error).message}`, true);
    return undefined;
  } finally {
    void queryClient.invalidateQueries({ queryKey: ['terminals'] });
  }
}
