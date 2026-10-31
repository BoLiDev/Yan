import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** A line set apart above what it is about, in amber: something that is not as it should be, but is not an error. */
export function Notice({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('mb-3.5 rounded-[10px] bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning', className)} {...props} />;
}
