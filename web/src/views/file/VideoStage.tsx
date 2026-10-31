import { useCallback, useEffect, useRef } from 'react';
import { bytes, pad } from '../../lib/format';
import { Stage } from './Stage';

/** A video as large as the pane lets it be, at its own shape, so no black bars frame it. */
export function VideoStage({ src, size, onMeta }: { src: string; size: number; onMeta: (meta: string) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const fit = useCallback(() => {
    const s = stage.current;
    const v = video.current;
    if (!s || !v) return;
    const w = v.videoWidth;
    const hgt = v.videoHeight;
    const style = getComputedStyle(s);
    const availW = s.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availH = s.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (!w || !hgt || availW <= 0 || availH <= 0) return;
    const scale = Math.min(availW / w, availH / hgt);
    v.style.width = `${Math.floor(w * scale)}px`;
    v.style.height = `${Math.floor(hgt * scale)}px`;
  }, []);
  useEffect(() => {
    if (!stage.current) return undefined;
    const watch = new ResizeObserver(fit);
    watch.observe(stage.current);
    return () => watch.disconnect();
  }, [fit]);
  return (
    <Stage at="video" ref={stage}>
      <video ref={video} controls preload="metadata" playsInline src={src}
        className="block max-h-full w-full rounded-[10px] bg-transparent shadow-[0_0_0_1px_var(--shadow-line),0_12px_32px_var(--shadow-drop)]"
        onLoadedMetadata={(e) => {
          fit();
          const v = e.currentTarget;
          const secs = Math.round(v.duration);
          const length = Number.isFinite(secs) ? `${Math.floor(secs / 60)}:${pad(secs % 60)}` : '';
          onMeta(['Video', `${v.videoWidth} × ${v.videoHeight}`, length, bytes(size)].filter(Boolean).join(' · '));
        }} />
    </Stage>
  );
}
