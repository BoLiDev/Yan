import type { ReactNode } from 'react';
import { Empty as EmptyState, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty';

/** What a pane says when it has nothing else to show: a title, and a line or two under it. */
export function Empty({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <EmptyState className="flex-1">
      <EmptyHeader>
        {title ? <EmptyTitle className="text-lg font-bold">{title}</EmptyTitle> : null}
        {children ? <EmptyDescription>{children}</EmptyDescription> : null}
      </EmptyHeader>
    </EmptyState>
  );
}
