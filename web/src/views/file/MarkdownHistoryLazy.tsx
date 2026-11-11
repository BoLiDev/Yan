import { lazy, Suspense, type ComponentProps } from 'react';
import { Empty, Scroll } from '../../components/page';

/** A Markdown file's history, loaded the first time one is asked for: most files are read and never looked back through. */
const History = lazy(() => import('./MarkdownHistory').then((m) => ({ default: m.MarkdownHistory })));

export function MarkdownHistory(props: ComponentProps<typeof History>) {
  return (
    <Suspense fallback={<Scroll><Empty>Loading…</Empty></Scroll>}>
      <History {...props} />
    </Suspense>
  );
}
