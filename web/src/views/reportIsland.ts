import DOMPurify from 'dompurify';
import type { Deliverable, DeliverableStatus, Report } from '../lib/api';
import { VIDEO, ext } from '../lib/files';
import { clock, dayOf, fromIso } from '../lib/format';

/**
 * artifacts/report.html, which the yan:uat skill writes, shown inside a
 * shadow root so its style and the page's leave each other alone, with what
 * serve adds on top: a deliverable is ticked, unticked or given up there and
 * task.json changes; a text is edited there and report.html changes. Either
 * is committed and pushed by the server, and arrives back as a new commit.
 *
 * The report is someone else's HTML, so this part is built by hand rather
 * than by React: built once for each report.html, and after that only told
 * what changed, the deliverables' states from task.json, or the facts in its
 * bar, so a push leaves the page as it was, scrolled and with whatever open.
 */

const REPORT_PANEL_CSS = `
.yan-bar{position:sticky;top:0;z-index:2;background:#000;border-bottom:1px solid #262626}
.yan-bar-in{max-width:880px;margin:0 auto;padding:12px 24px;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px}
.yan-facts{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;font-size:14px;color:#909090}
.yan-facts .file{font-family:ui-monospace,'SF Mono','Cascadia Mono',Menlo,Consolas,monospace;color:#fff}
.yan-said{color:#BCFF2F}.yan-said.bad{color:#FF8A8A}
.yan-legacy{position:relative;padding:2px 8px;border:none;border-radius:6px;background:#1F1F1F;color:#BCFF2F;font:12px ui-monospace,'SF Mono',Menlo,Consolas,monospace;cursor:help}
.yan-legacy .tip{display:none;position:absolute;left:0;top:calc(100% + 8px);z-index:3;min-width:260px;max-width:420px;padding:12px 14px;border-radius:10px;background:#121212;border:1px solid #3D3D3D;color:#DBDBDB;font:13px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;text-align:left;white-space:normal}
.yan-legacy:hover .tip,.yan-legacy:focus .tip{display:block}
.yan-tip-head{color:#909090;margin-bottom:4px}
.yan-actions{display:flex;flex-wrap:wrap;gap:8px}
.yan-btn{display:inline-flex;align-items:center;min-height:40px;padding:0 14px;box-sizing:border-box;border:1px solid #383838;border-radius:999px;background:#000;color:#fff;font:inherit;font-size:14px;text-decoration:none;cursor:pointer}
.yan-btn:hover{border-color:#6C6C6C;color:#fff}
.yan-btn.main{border:none;background:#BCFF2F;color:#000;font-weight:500}
.yan-btn.main:disabled{background:#3D3D3D;color:#909090;cursor:default}
.yan-uat{max-width:880px;margin:0 auto;padding:4px 24px 12px;box-sizing:border-box}
.yan-uat-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px 14px;padding:8px 0;border-bottom:1px solid #1F1F1F;font-size:14px}
.yan-uat-row .p{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;color:#fff;overflow-wrap:anywhere}
.yan-uat-row .w{grid-column:1/-1;color:#909090;font-size:13px}
.yan-uat-row a,.yan-uat-row button{color:#BDBDBD;font:inherit;font-size:13px;background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.yan-tick{all:unset;flex:none;display:flex;padding:11px;margin:-7px -1px 0 -11px;cursor:pointer;border-radius:8px}
.yan-tick:focus-visible{outline:2px solid #BCFF2F}
.yan-tick .box{margin-top:0}
[data-yan-status="abandoned"] .yan-tick{cursor:default}
/* a heading is one line, its summary giving way and never its number or its deliverable, as reports written now have it, and whole while it is edited; the box alone tells a state, so the badge of a report written before is not shown */
.line{flex-wrap:nowrap;min-width:0}
.line h3{display:flex;min-width:0;white-space:nowrap}
.line h3>*{flex:none}
.line h3 [data-yan-n]{white-space:pre}
.line h3 [data-yan-edit="summary"]{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.line h3:focus-within{display:block;white-space:normal}
.badge{display:none!important}
/* a report lays each deliverable out as a grid, its text under the box at full width: the button ends the first row */
.yan-side{flex:none;align-self:flex-start;grid-row:1;grid-column:3;min-height:36px;padding:0 12px;border:1px solid #383838;border-radius:999px;background:#000;color:#BDBDBD;font:inherit;font-size:13px;cursor:pointer}
.yan-side:hover{color:#fff;border-color:#6C6C6C}
[data-yan-edit],[data-yan-reason]{border-radius:4px;outline:1px dashed transparent;outline-offset:4px;transition:outline-color .12s}
[data-yan-edit]:hover,[data-yan-reason]:hover{outline-color:#3D3D3D}
[data-yan-edit]:focus,[data-yan-reason]:focus{outline:1px solid #BCFF2F}
.yan-video{display:flex;flex-direction:column;gap:10px}
.yan-video video{display:block;width:100%;border-radius:14px;border:1px solid #262626;background:#121212}
.yan-video .row{display:flex;align-items:center;gap:12px;font:13px ui-monospace,'SF Mono',Menlo,Consolas,monospace;color:#909090}
.yan-report figure img{cursor:zoom-in}
.yan-zoom{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:56px 72px;background:rgba(0,0,0,.78);outline:none}
.yan-zoom img{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.6)}
.yan-zoom .yan-zoom-close{position:fixed;top:16px;right:16px;display:flex;padding:10px;border:1px solid #383838;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;cursor:pointer}
.yan-zoom .yan-zoom-close:hover{border-color:#6C6C6C}
.yan-zoom .yan-zoom-n{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:4px 12px;border-radius:999px;background:rgba(0,0,0,.6);color:#BDBDBD;font:13px ui-monospace,'SF Mono',Menlo,Consolas,monospace}
.yan-zoom .yan-zoom-n:empty{display:none}
.yan-modal{position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px}
.yan-dialog{width:100%;max-width:440px;box-sizing:border-box;padding:24px;border-radius:16px;background:#121212;border:1px solid #262626;display:flex;flex-direction:column;gap:18px}
.yan-dialog .t{font-size:18px;font-weight:700;line-height:1.4;color:#fff}
.yan-dialog .s{font-size:14px;line-height:1.6;color:#909090}
.yan-dialog input{min-height:44px;padding:0 12px;border:1px solid #3D3D3D;border-radius:8px;background:#000;color:#fff;font:inherit;font-size:15px}
.yan-dialog .b{display:flex;justify-content:flex-end;gap:8px}
`;

const CLOSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

type Kid = Node | string | null | undefined | false | readonly Kid[];

/** An element, built by hand: `el('a', { class: 'row', href, onclick }, ...children)`. Text is always text. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'html') node.innerHTML = String(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (list: readonly Kid[]): void => {
    for (const k of list) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) add(k);
      else node.append(k as Node | string);
    }
  };
  add(kids);
  return node;
}

/**
 * The page's own nodes with nothing that runs, by DOMPurify: no scripts,
 * frames or handlers, links only to the web or to pictures inside. Its
 * styles are not among them; they are taken apart and scoped to the shadow
 * root. A link to the web opens in a tab of its own, since the report is
 * drawn in yan's page, which it would otherwise take the place of; one
 * written before reports said so is told here.
 */
const purify = DOMPurify();
purify.addHook('uponSanitizeAttribute', (_node, data) => {
  const name = data.attrName;
  if (name !== 'href' && name !== 'src' && name !== 'xlink:href') return;
  const v = data.attrValue.trim();
  if (!(name === 'href' ? /^(https?:|#)/i.test(v) : /^(https?:|data:image\/(png|jpe?g|gif|webp);)/i.test(v))) data.keepAttr = false;
});

/** report.html's body, clean, in a document of its own that loads nothing. */
function cleanReport(html: string): HTMLElement {
  // RETURN_DOM gives the body of DOMPurify's own document.
  const body = purify.sanitize(html, { RETURN_DOM: true, FORBID_TAGS: ['style', 'form', 'noscript', 'template'], FORBID_ATTR: ['srcdoc', 'formaction'] }) as HTMLElement;
  for (const a of body.querySelectorAll('a[href]')) {
    if (!/^https?:/i.test(a.getAttribute('href') ?? '')) continue;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
  }
  return body;
}

/**
 * A text of the report edited where it stands: Enter or leaving it keeps
 * what was typed, on one line, and Escape puts it back. A blank is never
 * kept. What it said is taken when it is entered, since the page can change
 * it in between, as a deliverable given up again does its reason.
 */
function editInPlace(node: HTMLElement, save: (text: string) => void): void {
  node.setAttribute('contenteditable', 'plaintext-only');
  node.setAttribute('spellcheck', 'false');
  let was = node.textContent ?? '';
  node.addEventListener('focus', () => {
    was = node.textContent ?? '';
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      node.blur();
    }
    if (e.key === 'Escape') {
      node.textContent = was;
      node.blur();
    }
  });
  node.addEventListener('blur', () => {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    const changed = text !== was.trim() && text !== '';
    if (text === '') node.textContent = was;
    if (changed) {
      was = text;
      save(text);
    }
  });
}

/**
 * A picture of the report large, in a modal over the page: fitted to the
 * window with a margin round it, the page dimmed behind. ← and → go through
 * the report's other pictures; Esc, ✕ or a click beside the picture closes it.
 */
function zoomShot(shell: HTMLElement, shots: HTMLImageElement[], start: number): void {
  let at = start;
  const img = el('img', { alt: '' });
  const n = el('span', { class: 'yan-zoom-n' });
  const close = (): void => view.remove();
  const view = el('div', { class: 'yan-zoom', tabindex: '-1', role: 'dialog', 'aria-modal': 'true', onclick: (e: Event) => { if (e.target === view) close(); } },
    img, n, el('button', { type: 'button', class: 'yan-zoom-close', 'aria-label': '关闭', onclick: close, html: CLOSE_ICON }));
  const show = (i: number): void => {
    at = (i + shots.length) % shots.length;
    img.src = (shots[at] as HTMLImageElement).src;
    img.alt = (shots[at] as HTMLImageElement).alt;
    n.textContent = shots.length > 1 ? `${at + 1} / ${shots.length}` : '';
  };
  view.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && shots.length > 1) show(at - 1);
    else if (e.key === 'ArrowRight' && shots.length > 1) show(at + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  shell.append(view);
  show(at);
  view.focus();
}

/** The pop-up for giving a deliverable up: a reason is needed, since `yan deliverable abandon` keeps it. */
function askReason(shell: HTMLElement, id: string, name: string, then: (reason: string) => void): void {
  const input = el('input', { 'aria-label': '放弃的原因', placeholder: '' });
  const ok = el('button', { type: 'button', class: 'yan-btn main', disabled: true }, '放弃');
  const close = (): void => modal.remove();
  const modal = el('div', { class: 'yan-modal', onclick: (e: Event) => { if (e.target === modal) close(); } },
    el('div', { class: 'yan-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': `放弃 ${id}` },
      el('div', null, el('div', { class: 't' }, `放弃 ${id.slice(1)}. ${name}？`), el('div', { class: 's' }, '写一句原因，以后不会再被提起')),
      input,
      el('div', { class: 'b' }, el('button', { type: 'button', class: 'yan-btn', onclick: close }, '取消'), ok)));
  input.addEventListener('input', () => {
    ok.disabled = input.value.trim() === '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && input.value.trim() !== '') ok.click();
  });
  ok.addEventListener('click', () => {
    const reason = input.value.trim();
    if (reason === '') return;
    close();
    then(reason);
  });
  shell.append(modal);
  input.focus();
}

export interface IslandHooks {
  /** A deliverable ticked, unticked or given up here; the island has already shown it. */
  readonly send: (id: string, to: DeliverableStatus, reason?: string) => void;
  /** Its reason for being given up, edited where it stands. */
  readonly reason: (id: string, reason: string) => void;
  /** A text of report.html, the `index`th that can be edited, changed. */
  readonly edit: (index: number, text: string) => void;
  readonly copied: (url: string) => void;
  /** Where a file of the task's uat/ opens, and downloads. */
  readonly uatUrl: (path: string) => string;
  readonly downloadUrl: string;
}

export interface Island {
  /** The bar's facts: when it was written, what changed since, what uat/ holds. */
  setFacts(rep: Report): void;
  /** The deliverables as task.json has them now, the counts with them. */
  setDeliverables(ds: readonly Deliverable[]): void;
  /** Last words said: what a change from the page came to. */
  say(text: string, bad: boolean): void;
}

/** Build the report in `root`, replacing what was there. */
export function buildIsland(root: ShadowRoot, rep: Report, ds: readonly Deliverable[], hooks: IslandHooks, said: { text: string; bad: boolean } | null): Island {
  const body = cleanReport(rep.html);
  const style = [...new DOMParser().parseFromString(rep.html, 'text/html').querySelectorAll('style')]
    .map((x) => x.textContent ?? '').join('\n')
    .replace(/:root\s*\{/g, ':host{').replace(/(^|[}\s,])body\s*\{/g, '$1.yan-report{');

  const facts = el('div', { class: 'yan-facts' });
  const saidEl = el('span', { class: 'yan-said' + (said?.bad ? ' bad' : '') }, said?.text ?? '');
  const uatList = el('div', { class: 'yan-uat', hidden: true });
  const uatButton = el('button', { type: 'button', class: 'yan-btn', 'aria-expanded': 'false', onclick: () => {
    uatList.hidden = !uatList.hidden;
    uatButton.setAttribute('aria-expanded', String(!uatList.hidden));
  } });
  const bar = el('div', { class: 'yan-bar' },
    el('div', { class: 'yan-bar-in' }, facts, el('div', { class: 'yan-actions' }, uatButton, el('a', { class: 'yan-btn main', href: hooks.downloadUrl }, '下载 HTML'))),
    uatList);
  const shell = el('div', { class: 'yan-report' }, bar, ...[...body.childNodes].map((n) => document.importNode(n, true)));
  root.replaceChildren(el('style', null, `${style}\n${REPORT_PANEL_CSS}`), shell);

  // The deliverables: ticked, unticked and given up here, shown as task.json has them now.
  // A click shows its result at once, counts included: the page is told again only once the
  // vault is committed and pushed, which can take seconds.
  const state = new Map<string, DeliverableStatus>(ds.map((x) => [x.id, x.status]));
  const live = new Set(ds.map((x) => x.id));
  const progress = shell.querySelector('[data-yan-progress]');
  // Progress is done out of what is to be delivered, the ones given up left out of both.
  const recount = (): void => {
    const wanted = [...state.values()].filter((s) => s !== 'abandoned');
    const done = wanted.filter((s) => s === 'done').length;
    if (progress) progress.textContent = `${done}/${wanted.length}`;
    shell.querySelector<HTMLElement>('[data-yan-bar="done"]')?.style.setProperty('width', `${wanted.length ? (done / wanted.length) * 100 : 0}%`);
    // A page rendered before has a part of the bar for the ones given up; it shows none now.
    shell.querySelector<HTMLElement>('[data-yan-bar="abandoned"]')?.style.setProperty('width', '0%');
  };
  const show = (node: HTMLElement, id: string, status: DeliverableStatus, reason: string | null | undefined): void => {
    node.dataset.yanStatus = status;
    const why = node.querySelector<HTMLElement>('[data-yan-reason]');
    if (why && document.activeElement !== why) why.textContent = status === 'abandoned' ? reason ?? '' : '';
    const tick = node.querySelector<HTMLButtonElement>('.yan-tick');
    if (tick) {
      tick.setAttribute('aria-label', status === 'done' ? `${id} 标回待确认` : `${id} 标为完成`);
      tick.disabled = status === 'abandoned';
    }
    const side = node.querySelector('.yan-side');
    if (side) side.textContent = status === 'abandoned' ? '恢复' : '放弃';
  };
  const send = (id: string, to: DeliverableStatus, reason?: string): void => {
    state.set(id, to);
    for (const node of shell.querySelectorAll<HTMLElement>(`[data-yan-d="${CSS.escape(id)}"]`)) show(node, id, to, reason);
    recount();
    hooks.send(id, to, reason);
  };
  for (const node of shell.querySelectorAll<HTMLElement>('[data-yan-d]')) {
    const id = node.dataset.yanD as string;
    if (!live.has(id)) continue;
    const box = node.querySelector('.box');
    const name = (node.querySelector('[data-yan-edit="summary"]') ?? node.querySelector('[data-yan-edit="text"]'))?.textContent || id;
    if (box) {
      const tick = el('button', { type: 'button', class: 'yan-tick', onclick: () => send(id, node.dataset.yanStatus === 'done' ? 'todo' : 'done') });
      box.replaceWith(tick);
      tick.append(box);
    }
    node.append(el('button', { type: 'button', class: 'yan-side',
      onclick: () => (node.dataset.yanStatus === 'abandoned' ? send(id, 'todo') : askReason(shell, id, name, (reason) => send(id, 'abandoned', reason))) }));
    // Its reason for being given up is edited like a text, but kept in task.json, which the page shows it from.
    const why = node.querySelector<HTMLElement>('[data-yan-reason]');
    if (why) editInPlace(why, (reason) => hooks.reason(id, reason));
  }

  // The texts: edited in place, saved to report.html when left.
  shell.querySelectorAll<HTMLElement>('[data-yan-edit]').forEach((node, index) => editInPlace(node, (text) => hooks.edit(index, text)));

  // The pictures: one clicked fills the screen.
  const shots = [...shell.querySelectorAll<HTMLImageElement>('figure img')];
  shots.forEach((img, i) => img.addEventListener('click', () => zoomShot(shell, shots, i)));

  // The recordings: played here, their link to copy.
  for (const line of shell.querySelectorAll<HTMLElement>('[data-yan-video]')) {
    const path = line.dataset.yanVideo as string;
    const info = rep.uat.find((f) => f.path === path);
    line.replaceWith(el('div', { class: 'yan-video' },
      el('video', { controls: true, preload: 'metadata', src: hooks.uatUrl(path) }),
      el('div', { class: 'row' }, el('span', null, path),
        info?.url ? el('button', { type: 'button', class: 'yan-btn', style: { minHeight: '32px' }, onclick: () => hooks.copied(info.url as string) }, '复制链接') : null)));
  }

  const island: Island = {
    setFacts(r) {
      const generated = r.generatedAt ? `生成于 ${dayOf(fromIso(r.generatedAt))} ${clock(fromIso(r.generatedAt))}` : null;
      const legacy = r.behind.length === 0 ? null : el('button', { type: 'button', class: 'yan-legacy', 'aria-label': `legacy: ${r.behind.join('; ')}` }, 'legacy',
        el('span', { class: 'tip' }, el('div', { class: 'yan-tip-head' }, '报告生成之后：'), r.behind.map((line) => el('div', null, line)),
          el('div', { class: 'yan-tip-head', style: { marginTop: '6px' } }, '重跑 /report 更新它')));
      facts.replaceChildren(...[el('span', { class: 'file' }, 'report.html'), generated ? el('span', null, generated) : null, legacy, saidEl].filter((x): x is HTMLElement => !!x));
      uatButton.textContent = `uat 素材 ${r.uat.length}`;
      uatList.replaceChildren(...(r.uat.length === 0 ? [el('div', { class: 'yan-uat-row' }, el('span', { class: 'w' }, 'uat/ 里还没有素材'))] : r.uat.map((f) => el('div', { class: 'yan-uat-row' },
        el('span', { class: 'p' }, f.path),
        VIDEO.has(ext(f.path)) && f.url ? el('button', { type: 'button', onclick: () => hooks.copied(f.url as string) }, '复制链接') : el('span', null),
        el('a', { href: `${hooks.uatUrl(f.path)}?download` }, '下载'),
        el('span', { class: 'w' }, f.for.length ? `${f.for.join('、')} · ${f.shows ?? ''}` : '没有用 yan uat 登记')))));
    },
    setDeliverables(next) {
      state.clear();
      for (const x of next) state.set(x.id, x.status);
      const byId = new Map(next.map((x) => [x.id, x]));
      for (const node of shell.querySelectorAll<HTMLElement>('[data-yan-d]')) {
        const now = byId.get(node.dataset.yanD as string);
        if (now) show(node, now.id, now.status, now.reason);
      }
      recount();
    },
    say(text, bad) {
      saidEl.textContent = text;
      saidEl.classList.toggle('bad', bad);
    },
  };
  island.setFacts(rep);
  island.setDeliverables(ds);
  return island;
}
