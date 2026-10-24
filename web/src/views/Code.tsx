import { useEffect, useMemo, useState } from 'react';
import { looksBinary } from '../lib/api';
import { KIND_LABEL, WRAPPED, badge, ext, kindOf } from '../lib/files';
import { bytes, plural } from '../lib/format';
import { colourLines, langOf } from '../lib/highlight';
import { Empty } from '../components/ui';
import { useLang, useText } from '../state/server';

/** A line's text as the page shows it: coloured when it was, plain otherwise. */
export function CodeText({ text, html }: { text: string; html?: string | null }) {
  if (html != null) return <span className="t" dangerouslySetInnerHTML={{ __html: html || ' ' }} />;
  return <span className="t">{text || ' '}</span>;
}

const LIMIT = 4000;

/** Lines with their numbers; past the first 4000, the rest wait for a click. */
export function CodeLines({ lines, wrap, coloured }: { lines: readonly string[]; wrap: boolean; coloured: readonly string[] | null }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines.length : Math.min(LIMIT, lines.length);
  const rows = [];
  for (let i = 0; i < shown; i++) {
    rows.push(<div className="ln" key={i}><span className="n">{i + 1}</span><CodeText text={lines[i] as string} html={coloured ? coloured[i] : null} /></div>);
  }
  return (
    <div className={'code' + (wrap ? ' wrap' : '')}>
      {rows}
      {!all && lines.length > LIMIT ? (
        <div className="more"><button type="button" className="button quiet" onClick={() => setAll(true)}>{`Show the other ${plural(lines.length - LIMIT, 'line')}`}</button></div>
      ) : null}
    </div>
  );
}

export function BinaryCard({ name, size }: { name: string; size?: number | null }) {
  return (
    <div className="file-card">
      <span className="big-kind">{badge(name)}</span><b>{name}</b>
      <span className="dim">{`Not text${size != null ? ` · ${bytes(size)}` : ''} — open or download it.`}</span>
    </div>
  );
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
  if (text.isError) return <div className="stage top"><Empty><span className="error">{String(text.error.message)}</span></Empty></div>;
  if (text.data === undefined || (!ready && !shaped)) return <div className="stage top"><Empty>Loading…</Empty></div>;
  if (!shaped) return <div className="stage"><BinaryCard name={name} size={size} /></div>;
  return <div className="stage top"><CodeLines lines={shaped.lines} wrap={wrap ?? WRAPPED.has(ext(name))} coloured={shaped.coloured} /></div>;
}
