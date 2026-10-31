import type { ReactNode } from 'react';
import type { BranchView as Branch, TaskSummary } from '../../lib/api';
import { baseName, ext, kindOf, viewerOf } from '../../lib/files';
import { bytes, short } from '../../lib/format';
import type { BranchRoute } from '../../lib/route';
import { Bar, Crumb, Empty } from '../../components/page';
import { useBranchTree, useText } from '../../state/server';
import { useUI } from '../../state/ui';
import { CodeStage } from '../Code';
import { MarkdownDoc } from '../Markdown';
import { useKeyNav } from '../nav';
import { Shot, Stage } from '../file/Stage';
import { forgeTools } from './tools';

/** A file as the branch has it: a picture, a markdown file drawn, or any other as text. */
export function BranchFile({ t, r, b }: { t: TaskSummary; r: BranchRoute; b: Branch }) {
  useKeyNav(null, null);
  const tree = useBranchTree(t.id, r.repo, b.head, !!r.item);
  const dark = useUI((s) => s.prefs.dark);
  const entry = tree.data?.find((f) => f.path === r.item);
  const url = entry ? `/api/branch/blob?task=${encodeURIComponent(t.id)}&repo=${r.repo}&sha=${entry.sha}` : null;
  const name = entry ? baseName(entry.path) : '';
  const isMarkdown = !!entry && viewerOf(name) === 'markdown';
  const text = useText(isMarkdown ? url : null);
  if (!r.item) return <Empty title={`${b.repo} at ${short(b.head)}`}>{`Every file on ${b.branch} — pick one in the middle.`}</Empty>;
  if (!tree.data) return <Empty title="Reading the files…" />;
  if (!entry || !url) return <Empty title="Not on the branch">{`${r.item} is not on ${b.branch}.`}</Empty>;
  let stage: ReactNode;
  if (kindOf(name) === 'image' && ext(name) !== 'svg') {
    stage = <Stage dark={dark}><Shot dark={dark} src={`${url}&name=${encodeURIComponent(name)}`} alt={name} /></Stage>;
  } else if (isMarkdown) {
    stage = (
      <Stage at="top">
        {text.data !== undefined ? (
          <div className="w-full max-w-[1000px] rounded-xl bg-card ring-1 ring-border"><MarkdownDoc text={text.data} /></div>
        ) : null}
      </Stage>
    );
  } else {
    stage = <CodeStage url={url} name={name} size={entry.size} />;
  }
  return (
    <>
      <Bar title={<Crumb path={entry.path} />} meta={bytes(entry.size)} tools={forgeTools(b).file(entry.path)} />
      {stage}
    </>
  );
}
