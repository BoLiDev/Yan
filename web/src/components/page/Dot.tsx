import { cn } from '../../lib/utils';

/**
 * Something new where it would otherwise be found by nobody: teal for what
 * arrived; for an agent, amber while it waits on `user`, green once it has
 * finished and nobody has looked.
 */
export function Dot({ title, tone = 'new' }: { title: string; tone?: 'new' | 'blocked' | 'finished' }) {
  return <span className={cn('size-[7px] flex-none rounded-full', { new: 'bg-brand', blocked: 'bg-warning', finished: 'bg-success' }[tone])} title={title} />;
}
