import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ArtifactFile } from '../lib/api';
import { KIND_LABEL, WRAPPED, baseName, dirName, enc, ext, kindOf, variantsOf, viewerOf } from '../lib/files';
import { bytes, plural } from '../lib/format';
import { Bar, BarSep, BarTools, Crumb, Empty, Scroll, Seg, Stepper, Tool } from '../components/page';
import { fileUrl, shaUrl, useIndex, useText, vaultPath } from '../state/server';
import { setPref, useUI } from '../state/ui';
import { CodeStage } from './Code';
import { MarkdownDoc } from './Markdown';
import { useKeyNav } from './nav';
import { FileCard, Shot, Stage } from './file/Stage';
import { FontStage } from './file/FontStage';
import { Foot, Pair } from './file/Foot';
import { PageFrame } from './file/PageFrame';
import { VideoStage } from './file/VideoStage';

export interface FileContext {
  readonly task: string;
  readonly file: ArtifactFile;
  readonly prev: string | null;
  readonly next: string | null;
  readonly pos: number;
  readonly total: number;
  /** The files in the same folder: a picture's variants are looked for among them. */
  readonly folderFiles: readonly ArtifactFile[];
  readonly fileHref: (path: string) => string;
  /** Named in the title, where the file is shown away from its task: in Latest. */
  readonly taskTitle?: string;
}

function MarkdownScroll({ task, file, onMeta }: { task: string; file: ArtifactFile; onMeta: (meta: string) => void }) {
  const text = useText(`/blob/${file.sha}`);
  useEffect(() => {
    if (text.data !== undefined) onMeta(`Markdown · ${plural(text.data.split('\n').length, 'line')} · ${bytes(file.size)}`);
  }, [text.data, file.size, onMeta]);
  if (text.isError) return <Scroll><Empty><span className="text-destructive">{String(text.error.message)}</span></Empty></Scroll>;
  if (text.data === undefined) return <Scroll><Empty>Loading…</Empty></Scroll>;
  return <Scroll><MarkdownDoc text={text.data} task={task} dir={dirName(`artifacts/${file.path}`)} outline /></Scroll>;
}

/** One file of a task, shown as what it is, with the tools for it and a line about it at its foot. */
export function FileView(ctx: FileContext) {
  const { task, file } = ctx;
  const name = baseName(file.path);
  const path = vaultPath(task, file.path);
  const viewer = viewerOf(name);
  const prefs = useUI((s) => s.prefs);
  const pageSource = useUI((s) => s.pageSource);
  const mdSource = useUI((s) => s.mdSource);
  const { data: index } = useIndex();
  const [meta, setMeta] = useState(`${KIND_LABEL[kindOf(name)].replace(/s$/, '')} · ${bytes(file.size)}`);
  const stage = useRef<HTMLDivElement>(null);
  useKeyNav(ctx.prev, ctx.next);

  const tools: ReactNode[] = [];
  const foot: ReactNode[] = [];
  let body: ReactNode = null;

  if (viewer === 'image') {
    tools.push(
      <Tool key="dark" name="dark" label="Dark backdrop" onClick={() => setPref('dark', !prefs.dark)} pressed={prefs.dark} />,
      <Tool key="full" name="full" label="Full screen (F)" onClick={() => void stage.current?.requestFullscreen?.()} />,
    );
    body = (
      <Stage dark={prefs.dark} ref={stage}>
        <Shot dark={prefs.dark} src={shaUrl(file.sha, name)} alt={name} decoding="async" onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth) setMeta(`${ext(name).toUpperCase()} · ${img.naturalWidth} × ${img.naturalHeight} · ${bytes(file.size)}`);
        }} />
        {/* A click near either edge goes to the file before or after, the pointer saying which way. */}
        {ctx.prev ? <a className="absolute inset-y-0 left-0 w-[18%] cursor-w-resize" href={ctx.prev} aria-label="Previous file" /> : null}
        {ctx.next ? <a className="absolute inset-y-0 right-0 w-[18%] cursor-e-resize" href={ctx.next} aria-label="Next file" /> : null}
      </Stage>
    );
    for (const v of variantsOf(name, ctx.folderFiles.map((f) => baseName(f.path))).slice(0, 2)) {
      const other = ctx.folderFiles.find((f) => baseName(f.path) === v.name) as ArtifactFile;
      foot.push(<Pair key={v.name} href={ctx.fileHref(other.path)} sha={other.sha} name={v.name} word={v.word} />);
    }
  } else if (viewer === 'page') {
    tools.push(
      <Seg key="width" options={[['fit', 'Fit'], ['1280', '1280'], ['390', '390']] as const} current={prefs.width} onPick={(w) => {
        useUI.setState({ pageSource: false });
        setPref('width', w);
      }} />,
      <Tool key="source" name="log" label={pageSource ? 'Show the page' : 'Show the source'} onClick={() => useUI.setState({ pageSource: !pageSource })} pressed={pageSource} />,
    );
    body = pageSource
      ? <CodeStage url={`/blob/${file.sha}`} name={name} size={file.size} onMeta={setMeta} />
      : <Stage at="page"><PageFrame src={fileUrl(path)} width={prefs.width} /></Stage>;
  } else if (viewer === 'markdown') {
    tools.push(<Seg key="md" options={[['doc', 'Rendered'], ['src', 'Source']] as const} current={mdSource ? 'src' : 'doc'} onPick={(v) => useUI.setState({ mdSource: v === 'src' })} />);
    body = mdSource
      ? <CodeStage url={`/blob/${file.sha}`} name={name} size={file.size} onMeta={setMeta} />
      : <MarkdownScroll task={task} file={file} onMeta={setMeta} />;
  } else if (viewer === 'text') {
    const e = ext(name);
    const wrap = prefs.wrap[e] ?? WRAPPED.has(e);
    tools.push(<Tool key="wrap" name="wrap" label={wrap ? 'Stop wrapping lines' : 'Wrap long lines'} onClick={() => setPref('wrap', { ...prefs.wrap, [e]: !wrap })} pressed={wrap} />);
    body = <CodeStage url={`/blob/${file.sha}`} name={name} size={file.size} wrap={wrap} onMeta={setMeta} />;
  } else if (viewer === 'audio') {
    body = <Stage><FileCard name={name}><audio className="w-[min(560px,100%)]" controls preload="metadata" src={fileUrl(path)} /></FileCard></Stage>;
  } else if (viewer === 'video') {
    body = <VideoStage src={fileUrl(path)} size={file.size} onMeta={setMeta} />;
  } else if (viewer === 'pdf') {
    body = <Stage at="page"><iframe src={fileUrl(path)} title={name} className="size-full rounded-[8px] border-0 bg-white" /></Stage>;
  } else if (viewer === 'font') {
    body = <FontStage file={file} name={name} />;
  }

  // This machine's copy in a tab of its own, the whole window given to it; then the file on the vault's
  // forge, where its link can be passed on, when yan can tell the forge.
  const web = index?.vault.fileLink;
  tools.push(<Tool key="tab" name="expand" label="Open in a new tab, full size" href={fileUrl(path)} />);
  if (web) tools.push(<Tool key="web" name="external" label={web.forge ? `Open on ${web.forge}` : "Open in the vault's repository"} href={web.template.replaceAll('{path}', enc(path))} />);
  tools.push(<Tool key="download" name="download" label="Download" href={fileUrl(path) + '?download'} newTab={false} />);

  return (
    <>
      <Bar
        title={<>{ctx.taskTitle ? <span className="font-normal text-ink-3">{`${ctx.taskTitle} · `}</span> : null}<Crumb path={file.path} /></>}
        meta={viewer === 'page' && !pageSource ? `Page · ${bytes(file.size)} · runs on its own origin, away from yan` : meta}
        tools={
          <>
            <Stepper prev={ctx.prev} next={ctx.next} pos={ctx.pos} total={ctx.total} what="file" />
            <BarSep />
            <BarTools>{tools}</BarTools>
          </>
        } />
      {body}
      <Foot file={file} path={path} local={`${index?.vault.dir ?? ''}/${path}`}>{foot}</Foot>
    </>
  );
}
