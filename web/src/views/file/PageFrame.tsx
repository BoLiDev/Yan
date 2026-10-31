import { useEffect, useRef } from 'react';

/** A page at a width: Fit fills the pane; 1280 is drawn at 1280 and scaled down to fit; 390 is a phone, at its size. */
export function PageFrame({ src, width }: { src: string; width: 'fit' | '1280' | '390' }) {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const box = wrap.current;
    const f = frame.current;
    if (!box || !f) return undefined;
    const fit = (): void => {
      const w = box.clientWidth;
      const hgt = box.clientHeight;
      if (!w || !hgt) return;
      if (width === 'fit') Object.assign(f.style, { width: `${w}px`, height: `${hgt}px`, transform: 'none', marginRight: '' });
      else {
        const target = Number(width);
        const scale = Math.min(1, w / target);
        Object.assign(f.style, { width: `${target}px`, height: `${hgt / scale}px`, transform: `scale(${scale})`, marginRight: `${target * scale - target}px` });
      }
    };
    const watch = new ResizeObserver(fit);
    watch.observe(box);
    fit();
    return () => watch.disconnect();
  }, [width]);
  return (
    <div className="relative flex size-full items-start justify-center overflow-hidden" ref={wrap}>
      {/* White whatever the theme, as a page is drawn on unless it says otherwise; scaled from its top left, where it starts. */}
      <iframe ref={frame} src={src} title="Page" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        className="origin-top-left rounded-[8px] border-0 bg-white shadow-[0_0_0_1px_var(--line),0_12px_32px_var(--shadow-drop)]" />
    </div>
  );
}
