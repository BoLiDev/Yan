import { useEffect, useRef } from 'react';
import type { ArtifactFile } from '../../lib/api';
import { dirName } from '../../lib/files';
import { bytes, plural } from '../../lib/format';
import { Empty, Scroll } from '../../components/page';
import { ReviewMenu } from '../../components/review/ReviewMenu';
import { inMarkdown, sourceLines } from '../../components/review/locate';
import { useUI } from '../../state/ui';
import { MarkdownDoc } from '../Markdown';
import { useMarkdownText } from './markdownText';
import { holdRenderedAt, renderedLine, useReadingPlace } from './place';

/**
 * A Markdown file drawn; edited in its source and not saved, drawn as
 * edited, which its line says. It opens where the file was being read, in
 * its source or here, and stays at what is being read when an agent changes
 * the file. What is selected in it is commented on, copied or edited from a
 * right click: Edit opens its source with the same words selected, or the
 * lines they are on where the source writes them otherwise.
 */
export function MarkdownScroll({ task, file, onMeta }: { task: string; file: ArtifactFile; onMeta: (meta: string) => void }) {
  const { key: path, loaded, edit, text } = useMarkdownText(task, file);
  const box = useRef<HTMLDivElement>(null);
  const lines = text === undefined ? 0 : text.split('\n').length;
  useEffect(() => {
    if (text !== undefined) onMeta(`Markdown · ${plural(lines, 'line')} · ${bytes(file.size)}${edit ? ' · edited in its source, not saved' : ''}`);
  }, [text, lines, edit, file.size, onMeta]);
  useReadingPlace(path, text !== undefined, text, {
    el: () => box.current,
    text: () => text,
    read: () => (box.current === null ? null : renderedLine(box.current, lines)),
    go: (line) => (box.current === null ? undefined : holdRenderedAt(box.current, line, lines)),
  });
  if (text === undefined && loaded.isError) return <Scroll><Empty><span className="text-destructive">{String(loaded.error.message)}</span></Empty></Scroll>;
  if (text === undefined) return <Scroll><Empty>Loading…</Empty></Scroll>;
  return (
    <Scroll ref={box}>
      <ReviewMenu task={task} locate={(range, el) => inMarkdown(`artifacts/${file.path}`, el, range, text)}
        onEdit={(range, quote, el) => {
          const at = sourceLines(el, range, lines);
          useUI.setState({ mdSource: true, mdSelect: at === null ? null : { key: path, ...at, quote } });
        }}>
        <MarkdownDoc text={text} task={task} dir={dirName(`artifacts/${file.path}`)} outline lines />
      </ReviewMenu>
    </Scroll>
  );
}
