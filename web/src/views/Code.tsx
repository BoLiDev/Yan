import { useEffect, useMemo, useState } from 'react';
import { looksBinary } from '../lib/api';
import { KIND_LABEL, WRAPPED, ext, kindOf } from '../lib/files';
import { bytes, plural } from '../lib/format';
import { colourLines, langOf } from '../lib/highlight';
import { cn } from '../lib/utils';
import { Empty } from '../components/page';
import { Button } from '../components/ui/button';
import { useLang, useText } from '../state/server';
import { FileCard, Stage } from './file/Stage';

/** A line's text as the page shows it: coloured when it was, plain otherwise. */
export function CodeText({ text, html, className }: { text: string; html?: string | null; className?: string }) {
  if (html != null) return <span className={className} dangerouslySetInnerHTML={{ __html: html || ' ' }} />;
  return <span className={className}>{text || ' '}</span>;
}

const LIMIT = 4000;

/** Lines with their numbers; past the first 4000, the rest wait for a click. */
export function CodeLines({ lines, wrap, coloured }: { lines: readonly string[]; wrap: boolean; coloured: readonly string[] | null }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines.length : Math.min(LIMIT, lines.length);
  const text = cn('min-w-0 flex-auto', wrap ? 'whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre');
  const rows = [];
  for (let i = 0; i < shown; i++) {
    rows.push(
      <div className="flex gap-4 pr-[18px] hover:bg-[var(--raised)]" key={i}>
        {/* The number out of a selection, so what is copied is the code alone. */}
        <span className="w-12 flex-none text-right text-ink-4 select-none">{i + 1}</span>
        <CodeText className={text} text={lines[i] as string} html={coloured ? coloured[i] : null} />
      </div>,
    );
  }
  return (
    <div className="mx-auto w-full self-stretch overflow-auto rounded-[12px] bg-card py-3 font-mono text-[12.5px]/5 text-ink ring-1 ring-border">
      {rows}
      {!all && lines.length > LIMIT ? (
        <div className="pt-2.5 pr-[18px] pb-0.5 pl-16"><Button variant="secondary" onClick={() => setAll(true)}>{`Show the other ${plural(lines.length - LIMIT, 'line')}`}</Button></div>
      ) : null}
    </div>
  );
}

export function BinaryCard({ name, size }: { name: string; size?: number | null }) {
  return <FileCard name={name}><span className="text-ink-3">{`Not text${size != null ? ` · ${bytes(size)}` : ''} — open or download it.`}</span></FileCard>;
}

/**
 * A text file on its stage, coloured by its language: read once from `url`,
 * named `name` for its language and its line count, which goes to `onMeta`.
 */
export function CodeStage({ url, name, size, wrap, onMeta }: { url: string; name: string; size?: number | null; wrap?: boolean; onMeta?: (meta: string) => void }) {
  const text = useText(url);
  const lang = langOf(name);
  const ready = useLang(lang);
  const shaped = useMemo(() => {
    if (text.data === undefined || looksBinary(text.data)) return null;
    const body = text.data.replace(/\r\n/g, '\n').replace(/\n$/, '');
    return { lines: body.split('\n'), coloured: ready ? colourLines(lang, body) : null };
  }, [text.data, lang, ready]);
  useEffect(() => {
    if (shaped && onMeta) onMeta(`${KIND_LABEL[kindOf(name)].replace(/s$/, '')} · ${plural(shaped.lines.length, 'line')}${size != null ? ` · ${bytes(size)}` : ''}`);
  }, [shaped, name, size, onMeta]);
  if (text.isError) return <Stage at="top"><Empty><span className="text-destructive">{String(text.error.message)}</span></Empty></Stage>;
  if (text.data === undefined || (!ready && !shaped)) return <Stage at="top"><Empty>Loading…</Empty></Stage>;
  if (!shaped) return <Stage><BinaryCard name={name} size={size} /></Stage>;
  return <Stage at="top"><CodeLines lines={shaped.lines} wrap={wrap ?? WRAPPED.has(ext(name))} coloured={shaped.coloured} /></Stage>;
}
