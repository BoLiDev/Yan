import { useEffect, useRef } from 'react';
import type { ArtifactFile } from '../../lib/api';
import { dirName } from '../../lib/files';
import { bytes, plural } from '../../lib/format';
import { Empty, Scroll } from '../../components/page';
import { MarkdownDoc } from '../Markdown';
import { useMarkdownText } from './markdownText';
import { holdRenderedAt, renderedLine, useKeepPlace, type Sync } from './place';

/**
 * A Markdown file drawn; edited in its source and not saved, drawn as
 * edited, which its line says. Swapped in for its source, it opens where the
 * source was being read, and says where it is when swapped back.
 */
export function MarkdownScroll({ task, file, onMeta, sync }: { task: string; file: ArtifactFile; onMeta: (meta: string) => void; sync?: Sync }) {
  const { key: path, loaded, edit, text } = useMarkdownText(task, file);
  const box = useRef<HTMLDivElement>(null);
  const lines = text === undefined ? 0 : text.split('\n').length;
  useEffect(() => {
    if (text !== undefined) onMeta(`Markdown · ${plural(lines, 'line')} · ${bytes(file.size)}${edit ? ' · edited in its source, not saved' : ''}`);
  }, [text, lines, edit, file.size, onMeta]);
  useKeepPlace(sync, path, text !== undefined, {
    read: () => (box.current === null ? null : renderedLine(box.current, lines)),
    go: (line) => (box.current === null ? undefined : holdRenderedAt(box.current, line, lines)),
  });
  if (text === undefined && loaded.isError) return <Scroll><Empty><span className="text-destructive">{String(loaded.error.message)}</span></Empty></Scroll>;
  if (text === undefined) return <Scroll><Empty>Loading…</Empty></Scroll>;
  return <Scroll ref={box}><MarkdownDoc text={text} task={task} dir={dirName(`artifacts/${file.path}`)} outline lines /></Scroll>;
}
