import { lazy, Suspense, type ComponentProps } from 'react';
import { Bar } from '../components/ui';

/**
 * The terminal, loaded the first time one is shown: xterm.js is a third of
 * the page's script, and most visits never open a terminal. Until it has
 * loaded, the terminal is its bar over the dark stage it will draw on.
 */
const Terminal = lazy(() => import('./Terminal').then((m) => ({ default: m.TerminalView })));

export function TerminalView(props: ComponentProps<typeof Terminal>) {
  return (
    <Suspense fallback={<><Bar title="Terminal" meta="" /><div className="term-tiles" /></>}>
      <Terminal {...props} />
    </Suspense>
  );
}
