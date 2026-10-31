import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** What a view shows below its bar, scrolling on its own while the bar stays put. */
export function Scroll({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-auto overflow-auto', className)} {...props} />;
}

/** A page of prose in a view: a column narrow enough to read, in the middle. */
export function Paper({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mx-auto max-w-[780px] px-10 pt-8 pb-[72px]', className)} {...props} />;
}
