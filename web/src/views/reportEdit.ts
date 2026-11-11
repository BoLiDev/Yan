import { MOD } from '../lib/format';

/**
 * A text of the report edited where it stands. A paragraph, the problem, a
 * step of the approach or a deliverable's text, takes lines: Enter starts
 * a new one and ⌘Enter keeps what was typed. A title or a heading is one
 * line, and Enter keeps it. Leaving a text keeps it too, and Escape puts
 * it back. A blank is never kept. While one is edited, a line under it
 * says which keys do what, since nothing else on the page would.
 */

/** The kinds of text that are one line: a title, a deliverable's heading. Every other kind is a paragraph. */
const ONE_LINE = new Set(['title', 'summary']);

/** Whether the text `node` holds takes lines; a reason for giving a deliverable up, which task.json keeps, does not. */
export const takesLines = (node: HTMLElement): boolean => node.dataset.yanEdit !== undefined && !ONE_LINE.has(node.dataset.yanEdit);

/**
 * A paragraph's lines are kept as they were typed, so they are drawn as
 * they were typed; and the line under a text being edited, which says its
 * keys. The report's own style, written before texts took lines, draws a
 * line break as a space.
 */
export const REPORT_EDIT_CSS = `
[data-yan-edit="text"],[data-yan-edit="problem"],[data-yan-edit="approach"]{white-space:pre-wrap}
.yan-report{position:relative}
.yan-keys{position:absolute;z-index:1;padding:3px 9px;border-radius:6px;background:#1F1F1F;color:#909090;font:12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;white-space:nowrap;pointer-events:none}
.yan-keys b{color:#DBDBDB;font-weight:500}
`;

/** What was typed, as it is kept: a paragraph's lines, without the space at their ends or more than one blank line between; a line, as one. */
function typed(node: HTMLElement, lines: boolean): string {
  if (!lines) return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  // innerText reads a line break however the browser wrote it into the text.
  return node.innerText.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The line that says a text's keys, under the frame drawn round it: round its line or paragraph when the text is a span. */
function keysUnder(shell: HTMLElement, node: HTMLElement, lines: boolean): HTMLElement {
  const hint = document.createElement('div');
  hint.className = 'yan-keys';
  const key = (k: string, does: string): string => `<b>${k}</b> ${does}`;
  hint.innerHTML = (lines ? [key('Enter', 'new line'), key(`${MOD}Enter`, 'saves'), key('Esc', 'cancels')] : [key('Enter', 'saves'), key('Esc', 'cancels')]).join(' · ');
  const place = (): void => {
    const framed = node.tagName === 'SPAN' ? node.parentElement ?? node : node;
    const [at, from] = [framed.getBoundingClientRect(), shell.getBoundingClientRect()];
    hint.style.left = `${at.left - from.left}px`;
    hint.style.top = `${at.bottom - from.top + 10}px`;
  };
  shell.append(hint);
  place();
  // It follows the text as it grows by a line.
  node.addEventListener('input', place);
  hint.addEventListener('yan-gone', () => node.removeEventListener('input', place), { once: true });
  return hint;
}

/** Make `node`, in the report `shell`, a text edited where it stands; `save` is given what was typed once it is kept. */
export function editInPlace(shell: HTMLElement, node: HTMLElement, save: (text: string) => void): void {
  const lines = takesLines(node);
  node.setAttribute('contenteditable', 'plaintext-only');
  node.setAttribute('spellcheck', 'false');
  let was = node.textContent ?? '';
  let hint: HTMLElement | null = null;
  node.addEventListener('focus', () => {
    // What it said is taken as it is entered: the page can change it in between, as a deliverable given up again does its reason.
    was = node.textContent ?? '';
    hint = keysUnder(shell, node, lines);
  });
  node.addEventListener('keydown', (e) => {
    // Enter that an input method takes to choose what it is composing is the input method's.
    if (e.isComposing) return;
    if (e.key === 'Enter' && (!lines || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      node.blur();
    }
    if (e.key === 'Escape') {
      node.textContent = was;
      node.blur();
    }
  });
  node.addEventListener('blur', () => {
    hint?.dispatchEvent(new Event('yan-gone'));
    hint?.remove();
    hint = null;
    const text = typed(node, lines);
    const changed = text !== was.trim() && text !== '';
    // Drawn as it is kept, whatever the browser wrote while it was typed.
    node.textContent = text === '' ? was : text;
    if (changed) {
      was = text;
      save(text);
    }
  });
}
