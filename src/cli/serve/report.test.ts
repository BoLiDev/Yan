import { describe, expect, it } from 'vitest';
import { behind, editText, editableCount, readRecord, restate } from './report.js';
import type { Deliverable } from './vault-view.js';

/** The parts of a page the report skill writes that serve reads. */
const PAGE = `<h1 data-yan-edit="title">iPad 录像页</h1>
<span class="bar"><span data-yan-bar="done" style="width:50.00%"></span><span data-yan-bar="abandoned" style="width:0.00%"></span></span><span data-yan-progress="">1 完成 · 1 待确认 · 0 放弃</span>
<p class="problem" data-yan-edit="problem">原来的问题。</p>
<div class="head" data-yan-d="d1" data-yan-status="done">
<h3><span>1. </span><span data-yan-edit="summary">横屏画面放大</span></h3>
<p class="why">放弃：<span data-yan-reason=""></span></p>
</div>
<li class="head" data-yan-d="d2" data-yan-status="todo">
<span class="item"><span>2. </span><span data-yan-edit="text">备份 &amp; 恢复</span></span>
<p class="why">放弃：<span data-yan-reason=""></span></p>
</li>`;

const d = (id: string, status: string, text = id, reason: string | null = null): Deliverable => ({ id, text, status, doneAt: null, reason });

describe('restate', () => {
  it('puts each deliverable in the state it has now, its reason and the counts with it', () => {
    const out = restate(PAGE, [d('d1', 'todo'), d('d2', 'abandoned', 'd2', '没有 <手机>')]);
    expect(out).toContain('data-yan-d="d1" data-yan-status="todo"');
    expect(out).toContain('data-yan-d="d2" data-yan-status="abandoned"');
    expect(out).toContain('<span data-yan-reason="">没有 &lt;手机&gt;</span>');
    expect(out.match(/<span data-yan-reason="">[^<]*<\/span>/g)).toEqual(['<span data-yan-reason=""></span>', '<span data-yan-reason="">没有 &lt;手机&gt;</span>']);
    expect(out).toContain('<span data-yan-progress="">0 完成 · 1 待确认 · 1 放弃</span>');
    expect(out).toContain('data-yan-bar="done" style="width:0.00%"');
    expect(out).toContain('data-yan-bar="abandoned" style="width:50.00%"');
  });
});

describe('editText', () => {
  it('replaces one text by its place among the editable ones, as text', () => {
    expect(editableCount(PAGE)).toBe(4);
    const out = editText(PAGE, 2, '横屏 <b>大了</b>\n一倍');
    expect(out).toContain('<span data-yan-edit="summary">横屏 &lt;b&gt;大了&lt;/b&gt; 一倍</span>');
    expect(out.replace('横屏 &lt;b&gt;大了&lt;/b&gt; 一倍', '横屏画面放大')).toBe(PAGE);
    expect(() => editText(PAGE, 4, 'x')).toThrow(RangeError);
  });
});

describe('behind', () => {
  const record = readRecord({
    generatedAt: '2026-10-18T12:00:00Z',
    deliverables: [{ id: 'd1', text: 'one', status: 'todo' }, { id: 'd2', text: 'two', status: 'todo' }, { id: 'd3', text: 'three', status: 'todo' }],
    files: { 'a.png': { sha256: 'aaa', for: ['d1'] }, 'b.png': { sha256: 'bbb', for: ['d2'] }, 'gone.png': { sha256: 'ggg', for: ['d1'] } },
    notes: { d3: 'checked by hand' },
  });

  it('is nothing when only the states changed', () => {
    expect(behind(record, [d('d1', 'done', 'one'), d('d2', 'abandoned', 'two'), d('d3', 'todo', 'three')], {
      files: [{ path: 'a.png', sha256: 'aaa', for: ['d1'] }, { path: 'b.png', sha256: 'bbb', for: ['d2'] }, { path: 'gone.png', sha256: 'ggg', for: ['d1'] }],
      notes: { d3: 'checked by hand' },
    })).toEqual([]);
  });

  it('names every deliverable and piece of evidence that changed since', () => {
    expect(behind(record, [d('d1', 'todo', 'one, reworded'), d('d3', 'todo', 'three'), d('d4', 'todo', 'four')], {
      files: [{ path: 'a.png', sha256: 'new', for: ['d1'] }, { path: 'b.png', sha256: 'bbb', for: ['d2', 'd3'] }, { path: 'c.png', sha256: 'ccc', for: ['d4'] }],
      notes: { d3: 'checked again', d4: 'by hand' },
    })).toEqual([
      'd1 的描述改了',
      '新加了 d4',
      'd2 不在了',
      'uat/a.png 换了新的',
      'uat/b.png 改成了证明 d2、d3',
      '新登记了 uat/c.png',
      'uat/gone.png 不再登记',
      'd3 的验证说明改了',
      'd4 加了验证说明',
    ]);
  });

  it('reads a record it half understands', () => {
    expect(readRecord({ deliverables: [{ id: 'd1' }, 'x'], files: { 'a.png': { for: ['d1'] } }, notes: { d1: 3 } })).toEqual({ generatedAt: null, deliverables: [], files: {}, notes: {} });
  });
});
