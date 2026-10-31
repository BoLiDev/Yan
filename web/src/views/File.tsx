import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getBytes, type ArtifactFile } from '../lib/api';
import { KIND_LABEL, WRAPPED, badge, baseName, dirName, enc, ext, kindOf, variantsOf, viewerOf } from '../lib/files';
import { bytes, pad, plural, short, when } from '../lib/format';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { Bar, Crumb, Empty, Seg, Tool } from '../components/ui';
import { fileUrl, shaUrl, thumbUrl, useIndex, useText, vaultPath } from '../state/server';
import { copyText, setPref, useUI } from '../state/ui';
import { BinaryCard, CodeStage } from './Code';
import { MarkdownDoc } from './Markdown';
import { useKeyNav } from './nav';

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

/** A page at a width: Fit fills the pane; 1280 is drawn at 1280 and scaled down to fit; 390 is a phone, at its size. */
function PageFrame({ src, width }: { src: string; width: 'fit' | '1280' | '390' }) {
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
    <div className="frame-wrap" ref={wrap}>
      <iframe ref={frame} src={src} title="Page" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
    </div>
  );
}

/** A video as large as the pane lets it be, at its own shape, so no black bars frame it. */
function VideoStage({ src, size, onMeta }: { src: string; size: number; onMeta: (meta: string) => void }) {
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
    <div className="stage video-stage" ref={stage}>
      <video ref={video} controls preload="metadata" playsInline src={src} onLoadedMetadata={(e) => {
        fit();
        const v = e.currentTarget;
        const secs = Math.round(v.duration);
        const length = Number.isFinite(secs) ? `${Math.floor(secs / 60)}:${pad(secs % 60)}` : '';
        onMeta(['Video', `${v.videoWidth} × ${v.videoHeight}`, length, bytes(size)].filter(Boolean).join(' · '));
      }} />
    </div>
  );
}

/** A font's own letters, at three sizes, from the file itself. */
function FontStage({ file, name }: { file: ArtifactFile; name: string }) {
  const [family, setFamily] = useState<string | null | false>(null);
  useEffect(() => {
    let live = true;
    void getBytes(`/blob/${file.sha}`).then(async (buf) => {
      const fam = `yan-preview-${file.sha.slice(0, 12)}`;
      const face = new FontFace(fam, buf);
      await face.load();
      document.fonts.add(face);
      if (live) setFamily(fam);
    }).catch(() => {
      if (live) setFamily(false);
    });
    return () => {
      live = false;
    };
  }, [file.sha]);
  if (family === false) return <div className="stage"><BinaryCard name={name} size={file.size} /></div>;
  if (family === null) return <div className="stage"><Empty>Loading the font…</Empty></div>;
  const sample = (px: number, text: string): ReactNode => <div style={{ fontFamily: `"${family}"`, fontSize: `${px}px`, lineHeight: 1.35 }}>{text}</div>;
  return (
    <div className="stage">
      <div className="font-sample">
        <span className="dim" style={{ fontSize: '12.5px' }}>{name}</span>
        {sample(44, '永和九年 Aa Bb 0123')}
        {sample(24, '天地玄黄，宇宙洪荒。The quick brown fox jumps over the lazy dog.')}
        {sample(16, '一切有为法，如梦幻泡影。ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 ,.;:!?()[]{}')}
      </div>
    </div>
  );
}

function MarkdownScroll({ task, file, onMeta }: { task: string; file: ArtifactFile; onMeta: (meta: string) => void }) {
  const text = useText(`/blob/${file.sha}`);
  useEffect(() => {
    if (text.data !== undefined) onMeta(`Markdown · ${plural(text.data.split('\n').length, 'line')} · ${bytes(file.size)}`);
  }, [text.data, file.size, onMeta]);
  if (text.isError) return <div className="scroll"><Empty><span className="error">{String(text.error.message)}</span></Empty></div>;
  if (text.data === undefined) return <div className="scroll"><Empty>Loading…</Empty></div>;
  return <div className="scroll"><MarkdownDoc text={text.data} task={task} dir={dirName(`artifacts/${file.path}`)} outline /></div>;
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
      <div className={'stage' + (prefs.dark ? ' dark' : '')} ref={stage}>
        <img className="shot" src={shaUrl(file.sha, name)} alt={name} decoding="async" onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth) setMeta(`${ext(name).toUpperCase()} · ${img.naturalWidth} × ${img.naturalHeight} · ${bytes(file.size)}`);
        }} />
        {ctx.prev ? <a className="hit prev" href={ctx.prev} aria-label="Previous file" /> : null}
        {ctx.next ? <a className="hit next" href={ctx.next} aria-label="Next file" /> : null}
      </div>
    );
    for (const v of variantsOf(name, ctx.folderFiles.map((f) => baseName(f.path))).slice(0, 2)) {
      const other = ctx.folderFiles.find((f) => baseName(f.path) === v.name) as ArtifactFile;
      foot.push(
        <a key={v.name} className="pair" href={ctx.fileHref(other.path)}>
          <img src={thumbUrl(other.sha, v.name, 'row')} alt="" decoding="async" />
          {/^\d+$/.test(v.word) ? `Same screen at ${v.word}` : `Same screen, ${v.word}`}
        </a>,
      );
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
      : <div className="stage page"><PageFrame src={fileUrl(path)} width={prefs.width} /></div>;
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
    body = (
      <div className="stage">
        <div className="file-card"><span className="big-kind">{badge(name)}</span><b>{name}</b><audio controls preload="metadata" src={fileUrl(path)} /></div>
      </div>
    );
  } else if (viewer === 'video') {
    body = <VideoStage src={fileUrl(path)} size={file.size} onMeta={setMeta} />;
  } else if (viewer === 'pdf') {
    body = <div className="stage page"><iframe src={fileUrl(path)} title={name} style={{ width: '100%', height: '100%', border: 0, borderRadius: '8px', background: '#fff' }} /></div>;
  } else if (viewer === 'font') {
    body = <FontStage file={file} name={name} />;
  }

  // This machine's copy in a tab of its own, the whole window given to it; then the file on the vault's
  // forge, where its link can be passed on, when yan can tell the forge.
  const web = index?.vault.fileLink;
  tools.push(<Tool key="tab" name="expand" label="Open in a new tab, full size" href={fileUrl(path)} />);
  if (web) tools.push(<Tool key="web" name="external" label={web.forge ? `Open on ${web.forge}` : "Open in the vault's repository"} href={web.template.replaceAll('{path}', enc(path))} />);
  tools.push(<Tool key="download" name="download" label="Download" href={fileUrl(path) + '?download'} newTab={false} />);

  const local = `${index?.vault.dir ?? ''}/${path}`;
  return (
    <>
      <Bar
        title={<>{ctx.taskTitle ? <span className="dir">{`${ctx.taskTitle} · `}</span> : null}<Crumb path={file.path} /></>}
        meta={viewer === 'page' && !pageSource ? `Page · ${bytes(file.size)} · runs on its own origin, away from yan` : meta}
        tools={
          <>
            <div className="group-tools">
              <Tool name="prev" label="Previous file (←)" href={ctx.prev} newTab={false} disabled={!ctx.prev} />
              <span className="counter">{ctx.total ? `${ctx.pos} / ${ctx.total}` : ''}</span>
              <Tool name="next" label="Next file (→)" href={ctx.next} newTab={false} disabled={!ctx.next} />
            </div>
            <span className="sep" />
            <div className="group-tools">{tools}</div>
          </>
        } />
      {body}
      <div className="foot">
        {file.added ? <span title={file.changed !== file.added ? `changed ${when(file.changed)}` : ''}>{`Added ${when(file.added)}`}</span> : null}
        {file.commit ? <span className="mono" style={{ fontSize: '12px' }} title={file.commit}>{short(file.commit)}</span> : null}
        <Button variant="ghost" size="xs" className="max-w-full min-w-0 justify-start font-mono text-xs font-normal text-ink-3" title="Copy the path on this machine" onClick={() => copyText(local, 'Path copied', 'The path')}><span className="truncate">{path}</span><Icon name="copy" size={13} /></Button>
        <span className="grow" />
        {foot}
      </div>
    </>
  );
}
