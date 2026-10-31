import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { postJSON, stateOf, statusOf, type TaskDetail, type TaskState, type TaskSummary, type WriteResult } from '../lib/api';
import { dayOf, fromIso, when } from '../lib/format';
import { blocksOf } from '../lib/markdown';
import { link } from '../lib/route';
import { Icon } from '../components/Icon';
import { Editable } from '../components/ui';
import { onStatus, useText, writeTask } from '../state/server';
import { ask, setSeen, toast, useUI } from '../state/ui';
import { MarkdownDoc } from './Markdown';
import { useKeyNav } from './nav';

/** Text with its web addresses as links. */
export function Linkified({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /https?:\/\/[^\s<>()（）「」，。；、]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    out.push(<a key={m.index} href={m[0]} target="_blank" rel="noopener">{m[0]}</a>);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/**
 * problem.md opened to edit, whole, as the Markdown it is. Saving is refused
 * when an agent changed the file since this page read it, so neither
 * overwrites the other; while it is open, what is typed stays, whatever
 * arrives.
 */
function ProblemEditor({ t, d, onClose }: { t: TaskSummary; d: TaskDetail; onClose: () => void }) {
  const text = d.problem?.text ?? '';
  // The sha the edit started from, so a save after an agent's change is refused.
  const [from] = useState(d.problem?.sha ?? '');
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  useEffect(() => area.current?.focus(), []);
  const save = (): void => {
    if (value.trim() === '') return toast('problem 不能是空的');
    if (value === text) return onClose();
    setBusy(true);
    postJSON<WriteResult>('/api/problem', { task: t.id, sha: from, text: value }).then((out) => {
      toast(out.warning ? `已保存 problem.md，推送没成功：${out.warning}` : '已保存 problem.md');
      onClose();
      void onStatus(out.status);
    }, (err: Error) => {
      setBusy(false);
      toast(`没保存：${err.message}`);
    });
    return undefined;
  };
  return (
    <>
      <textarea ref={area} className="ov-problem" spellCheck={false} aria-label="problem.md" value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
          if (e.key === 'Escape') {
            if (value === text) onClose();
            else toast('有没保存的修改：放弃就点取消');
          }
        }} />
      <div className="ov-edit-bar">
        <span className="dim">Markdown · ⌘↩ 保存 · Esc 取消</span>
        <button type="button" className="button quiet" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="button" disabled={busy} onClick={save}>保存</button>
      </div>
    </>
  );
}

/**
 * problem.md, with what changed since the last look tinted. The visit's
 * starting point is kept for as long as the task is open, so the tint stays
 * while it is read, and the file counts as seen once shown.
 */
function Problem({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  const [editing, setEditing] = useState(false);
  const problem = d.problem;
  // Where this visit started from: kept once the problem is shown, and until then what was last seen.
  const was = useUI((s) => (t.id in s.problemBase ? s.problemBase[t.id] : s.seen?.problems[t.id]) ?? null);
  useEffect(() => {
    if (!problem?.text.trim()) return;
    const s = useUI.getState();
    if (!(t.id in s.problemBase)) useUI.setState({ problemBase: { ...s.problemBase, [t.id]: s.seen?.problems[t.id] ?? null } });
    setSeen((seen) => (seen.problems[t.id] === problem.sha ? null : { ...seen, problems: { ...seen.problems, [t.id]: problem.sha } }));
  }, [t.id, problem]);
  const old = useText(problem && was && was !== problem.sha ? `/blob/${was}` : null);
  const before = useMemo(() => (old.data !== undefined ? blocksOf(old.data) : null), [old.data]);
  const waiting = !!problem && !!was && was !== problem.sha && old.data === undefined && !old.isError;
  const fresh = useMemo(() => !!before && !!problem && [...blocksOf(problem.text)].some((b) => b !== '' && !before.has(b)), [before, problem]);

  const edit = editing ? null : <button type="button" className="ov-edit" onClick={() => setEditing(true)}><Icon name="edit" size={14} />编辑</button>;
  if (!problem || !problem.text.trim()) {
    return (
      <section className="ov-section">
        <div className="h"><h3>Problem</h3>{edit}</div>
        {editing ? <ProblemEditor t={t} d={d} onClose={() => setEditing(false)} /> : <div><span className="dim">No problem written yet.</span></div>}
      </section>
    );
  }
  const name = problem.path.slice(problem.path.lastIndexOf('/') + 1);
  return (
    <section className="ov-section">
      <div className="h"><h3>Problem</h3><span>{`${name}${problem.changed ? ` · written ${when(problem.changed)}` : ''}`}</span>{edit}</div>
      {editing ? <ProblemEditor t={t} d={d} onClose={() => setEditing(false)} /> : (
        <div>{waiting ? null : <MarkdownDoc text={problem.text} task={t.id} dir="" before={before} dropTitle bare />}</div>
      )}
      {!editing && fresh ? <span className="dim" style={{ fontSize: '12.5px' }}>The tinted parts are new since you last looked.</span> : null}
    </section>
  );
}

const STATE_WORD: Readonly<Record<TaskState, readonly [string, string]>> = { open: ['teal', 'In progress'], uat: ['amber', '验收中'], done: ['green', 'Done'], abandoned: ['', 'Dropped'] };

/** A task as a whole: where it stands, its problem and its deliverables. */
export function Overview({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  useKeyNav(null, null);
  // A state this page does not know, a newer yan's, is named as task.json has it.
  const word = t.state === stateOf(t.state) ? STATE_WORD[stateOf(t.state)] : ['teal', t.state];
  const dates = [t.id, t.createdAt ? `started ${dayOf(fromIso(t.createdAt))}` : null, t.closedAt ? `${t.state === 'done' ? 'done' : 'closed'} ${dayOf(fromIso(t.closedAt))}` : null].filter(Boolean).join(' · ');
  const ds = d.deliverables;
  const n = (s: string): number => ds.filter((x) => x.status === s).length;
  const counts = [n('done') ? `${n('done')} done` : null, n('todo') ? `${n('todo')} to do` : null, n('abandoned') ? `${n('abandoned')} dropped` : null].filter(Boolean).join(' · ');
  return (
    <div className="scroll">
      <div className="paper">
        <header className="ov-head">
          <div className="pills">
            <span className={`pill ${word[0]}`}>{word[1]}</span>
            <span className="pill">{dates}</span>
            {d.repos.map((repo, i) => (repo.branch
              ? <a key={i} className="pill" href={link.branch(t.id, i)}><Icon name="branch" size={13} />{`${repo.name} · ${repo.branch}`}</a>
              : <span key={i} className="pill">{repo.name}</span>))}
          </div>
          <h2>{t.title || t.id}</h2>
        </header>
        {t.state === 'abandoned' && d.reason ? <p className="notice">{`Dropped: ${d.reason}`}</p> : null}
        <Problem t={t} d={d} />
        {ds.length ? (
          // A text clicked is edited; one given up keeps its reason on its line, and one deleted with the bin goes as if never added, the ones after it taking its number.
          <section className="ov-section">
            <div className="h"><h3>Deliverables</h3><span>{counts}</span></div>
            <div className="rail">
              {ds.map((x) => (
                <div key={x.id} className={`deliv ${statusOf(x.status)}`}>
                  <span className="node" title={x.status} />
                  <span>
                    <span className="text">
                      <span className="id">{x.id}</span>
                      <Editable className="words" text={x.text} onSave={(text) => void writeTask('/api/deliverable/text', { task: t.id, id: x.id, text }, `已保存 ${x.id}`)} />
                    </span>
                    {x.reason ? <Editable className="why" text={x.reason} onSave={(reason) => void writeTask('/api/deliverable', { task: t.id, id: x.id, to: 'abandoned', reason }, `已保存 ${x.id} 的放弃理由`)} /> : null}
                  </span>
                  <span className="side">
                    <span className="at">{x.doneAt ? x.doneAt.slice(5).replace('-', '.') : ''}</span>
                    <span className="acts">
                      {x.status === 'abandoned' ? null : (
                        <button type="button" className="ov-icon" title={`放弃 ${x.id}`} aria-label={`放弃 ${x.id}`}
                          onClick={() => ask({ title: `放弃 ${x.id}？`, sub: x.text, action: '放弃', reason: '写一句原因，它会留在这条 deliverable 下面',
                            then: (reason) => void writeTask('/api/deliverable', { task: t.id, id: x.id, to: 'abandoned', reason }, `已放弃 ${x.id}`) })}>
                          <Icon name="ban" size={15} />
                        </button>
                      )}
                      <button type="button" className="ov-icon remove" title={`删除 ${x.id}`} aria-label={`删除 ${x.id}`}
                        onClick={() => ask({ title: `删除 ${x.id}？`, sub: x.text, action: '删除', then: () => void writeTask('/api/deliverable/remove', { task: t.id, id: x.id }, `已删除 ${x.id}`) })}>
                        <Icon name="trash" size={15} />
                      </button>
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
