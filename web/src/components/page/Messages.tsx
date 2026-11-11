import { CheckIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { Toaster } from 'sonner';
import { MESSAGES } from '../../state/ui';

/**
 * What was just done, said in a word (`message`): a copy, a save, a
 * rename, or why a click did nothing. A small pill at the top of the page,
 * as a phone or a web framework says it, gone in a moment; not a toast at
 * the foot, which is for what needs reading, an error with its reason or an
 * agent's words. White whatever the theme, as a toast is, so it stands off a
 * dark page; one at a time, a new one in the old one's place.
 */
export function Messages() {
  return (
    <Toaster id={MESSAGES} position="top-center" offset={14} visibleToasts={1} theme="light"
      icons={{
        success: <CheckIcon className="size-3.5 text-success" strokeWidth={2.5} />,
        info: <InfoIcon className="size-3.5 text-brand" strokeWidth={2.25} />,
        warning: <TriangleAlertIcon className="size-3.5 text-warning" strokeWidth={2.25} />,
      }}
      toastOptions={{
        unstyled: true,
        duration: 1600,
        classNames: {
          // sonner lays each out at a fixed width from the box's left: stretched across it, and as wide as its words, it stands in the middle.
          toast: 'inset-x-0! mx-auto! flex w-fit! max-w-[min(420px,calc(100vw-32px))] items-center gap-1.5 rounded-full bg-(--toast-bg) py-1.5 pr-3.5 pl-3 text-[13px] leading-5 text-(--toast-ink) [filter:drop-shadow(0_0_0.5px_rgba(0,0,0,.2))_drop-shadow(0_4px_12px_rgba(0,0,0,.12))]',
          icon: 'flex size-3.5 flex-none items-center justify-center',
          title: 'truncate font-medium',
        },
      }} />
  );
}
