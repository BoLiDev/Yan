import { describe, expect, it } from 'vitest';
import { behind, editText, editableCount, handout, imagesOut, readRecord } from './report.js';
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

describe('handout', () => {
  it('puts each deliverable in the state it has now, with the counts of them', () => {
    const out = handout(PAGE, [d('d1', 'todo'), d('d2', 'done')]);
    expect(out).toContain('data-yan-d="d1" data-yan-status="todo"');
    expect(out).toContain('data-yan-d="d2" data-yan-status="done"');
    expect(out).toContain('<span data-yan-progress="">1/2</span>');
    expect(out).toContain('data-yan-bar="done" style="width:50.00%"');
  });

  /** Two blocks, one holding two deliverables, then the list of the others. */
  const GROUPS = `<p>top</p>
<span data-yan-bar="done" style="width:0.00%"></span><span data-yan-bar="abandoned" style="width:0.00%"></span><span data-yan-progress="">0 完成 · 5 待确认 · 0 放弃</span>
<div data-yan-group="">
<h2>DELIVERABLES</h2>
<section data-yan-group="">
<div class="heads">
<div class="head" data-yan-d="d1" data-yan-status="todo">
<div class="words"><h3>one</h3><p class="why">放弃：<span data-yan-reason=""></span></p></div>
</div>
<div class="head" data-yan-d="d2" data-yan-status="todo">
<div class="words"><h3>two</h3><p class="why">放弃：<span data-yan-reason=""></span></p></div>
</div>
</div>
<div class="grid"><figure><img src="one.png"></figure></div>
</section>
<section data-yan-group="">
<div class="heads">
<div class="head" data-yan-d="d3" data-yan-status="todo">
<div class="words"><h3>three</h3></div>
</div>
</div>
<div class="grid"><figure><img src="three.png"></figure></div>
</section>
</div>
<div data-yan-group="">
<h2 data-yan-alone="DELIVERABLES">其他 DELIVERABLES</h2>
<ol>
<li class="head" data-yan-d="d4" data-yan-status="todo"><div class="words">four</div></li>
<li class="head" data-yan-d="d5" data-yan-status="todo"><div class="words">five</div></li>
</ol>
</div>
<p>end</p>`;

  it('leaves the deliverables given up out, and a block or list with nothing left in it', () => {
    const out = handout(GROUPS, [d('d1', 'abandoned', 'd1', 'no'), d('d2', 'done'), d('d3', 'abandoned'), d('d4', 'abandoned'), d('d5', 'todo')]);
    expect(out).not.toMatch(/data-yan-d="d[134]"|one<|three|four|>no</);
    expect(out).toContain('<h3>two</h3>');
    expect(out).toContain('one.png');
    expect(out.match(/<section/g)).toHaveLength(1);
    expect(out).toContain('<h2 data-yan-alone="DELIVERABLES">其他 DELIVERABLES</h2>');
    expect(out).toContain('<span data-yan-progress="">1/2</span>');
    expect(out).toContain('data-yan-bar="done" style="width:50.00%"');
    expect(out).toContain('data-yan-bar="abandoned" style="width:0.00%"');
    expect(out.match(/<div/g)?.length).toBe(out.match(/<\/div>/g)?.length);
  });

  it('drops a heading with nothing under it, and names the others plainly once they are all there is', () => {
    const out = handout(GROUPS, ['d1', 'd2', 'd3'].map((id) => d(id, 'abandoned')).concat([d('d4', 'done'), d('d5', 'done')]));
    expect(out).not.toContain('<section');
    expect(out).not.toContain('<h2>DELIVERABLES</h2>');
    expect(out).toContain('<h2 data-yan-alone="DELIVERABLES">DELIVERABLES</h2>');
    expect(out).toMatch(/<p>top<\/p>[\s\S]*data-yan-d="d4"[\s\S]*<p>end<\/p>$/);
    expect(handout(GROUPS, ['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => d(id, 'abandoned')))).not.toMatch(/<h2|<ol|data-yan-group/);
  });

  /** A page numbered by place: three blocks, then the ones given up when it was written. */
  const NUMBERED = `<div data-yan-group="">
<h2>DELIVERABLES</h2>
<section data-yan-group=""><div class="head" data-yan-d="d1" data-yan-status="todo"><h3><span data-yan-n="">1. </span>one</h3></div><div class="grid"></div></section>
<section data-yan-group=""><div class="head" data-yan-d="d2" data-yan-status="todo"><h3><span data-yan-n="">2. </span>two</h3></div><div class="grid"></div></section>
<section data-yan-group=""><div class="head" data-yan-d="d3" data-yan-status="todo"><h3><span data-yan-n="">3. </span>three</h3></div></section>
</div>
<div data-yan-group="">
<h2>ABANDONED DELIVERABLES</h2>
<ol>
<li class="head" data-yan-d="d4" data-yan-status="abandoned"><span class="item"><span data-yan-n="">1. </span>four</span></li>
<li class="head" data-yan-d="d5" data-yan-status="abandoned"><span class="item"><span data-yan-n="">2. </span>five</span></li>
</ol>
</div>`;

  it('numbers what is left from 1 again under each heading', () => {
    const out = handout(NUMBERED, [d('d1', 'abandoned'), d('d2', 'done'), d('d3', 'todo'), d('d4', 'abandoned'), d('d5', 'abandoned')]);
    expect(out).toContain('<span data-yan-n="">1. </span>two');
    expect(out).toContain('<span data-yan-n="">2. </span>three');
    expect(out).not.toMatch(/>one<|ABANDONED|four|five/);
    // One given up when the page was written, and taken back since, counts under its own heading.
    const back = handout(NUMBERED, [d('d1', 'done'), d('d2', 'done'), d('d3', 'done'), d('d4', 'abandoned'), d('d5', 'todo')]);
    expect(back).toContain('<span data-yan-n="">3. </span>three');
    expect(back).toContain('<span data-yan-n="">1. </span>five');
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

describe('imagesOut', () => {
  it('takes each picture out of the page, in order, pointing it where it will be served and loading it as it comes near', () => {
    const png = Buffer.from('a png');
    const jpg = Buffer.from('a jpg');
    const page = `<figure><span class="tag">改前</span><img src="data:image/png;base64,${png.toString('base64')}" alt="before"></figure>
<figure><img src="data:image/jpeg;base64,${jpg.toString('base64')}" alt="after"></figure>
<img src="https://example.com/x.png" alt="away">`;
    const { html, images } = imagesOut(page, (n) => `http://localhost:4748/_report/abc/${n}`);
    expect(images.map((x) => [x.type, x.bytes.toString()])).toEqual([['image/png', 'a png'], ['image/jpeg', 'a jpg']]);
    expect(html).toBe(`<figure><span class="tag">改前</span><img loading="lazy" decoding="async" src="http://localhost:4748/_report/abc/0" alt="before"></figure>
<figure><img loading="lazy" decoding="async" src="http://localhost:4748/_report/abc/1" alt="after"></figure>
<img src="https://example.com/x.png" alt="away">`);
  });
});

describe('behind', () => {
  const record = readRecord({
    generatedAt: '2026-10-18T12:00:00Z',
    deliverables: [{ id: 'd1', text: 'one', status: 'todo' }, { id: 'd2', text: 'two', status: 'todo' }, { id: 'd3', text: 'three', status: 'todo' }],
    files: { 'a.png': { sha256: 'aaa', for: ['d1'] }, 'b.png': { sha256: 'bbb', for: ['d2'] }, 'gone.png': { sha256: 'ggg', for: ['d1'] } },
    notes: { d3: 'checked by hand' },
  });

  // A report.json from before the page left the notes off still has them; they are not compared.
  it('is nothing when only the states changed', () => {
    expect(behind(record, [d('d1', 'done', 'one'), d('d2', 'abandoned', 'two'), d('d3', 'todo', 'three')], {
      files: [{ path: 'a.png', sha256: 'aaa', for: ['d1'] }, { path: 'b.png', sha256: 'bbb', for: ['d2'] }, { path: 'gone.png', sha256: 'ggg', for: ['d1'] }],
    })).toEqual([]);
  });

  it('names every deliverable and piece of evidence that changed since', () => {
    expect(behind(record, [d('d1', 'todo', 'one, reworded'), d('d3', 'todo', 'three'), d('d4', 'todo', 'four')], {
      files: [{ path: 'a.png', sha256: 'new', for: ['d1'] }, { path: 'b.png', sha256: 'bbb', for: ['d2', 'd3'] }, { path: 'c.png', sha256: 'ccc', for: ['d4'] }],
    })).toEqual([
      'd1 的描述改了',
      '新加了 d4',
      'd2 不在了',
      'uat/a.png 换了新的',
      'uat/b.png 改成了证明 d2、d3',
      '新登记了 uat/c.png',
      'uat/gone.png 不再登记',
    ]);
  });

  it('reads a record it half understands', () => {
    expect(readRecord({ deliverables: [{ id: 'd1' }, 'x'], files: { 'a.png': { for: ['d1'] } }, notes: { d1: 3 } })).toEqual({ generatedAt: null, deliverables: [], files: {} });
  });
});
