/**
 * A page an agent wrote, made reviewable where `yan serve`'s page shows it.
 * It runs in a frame on the files' origin, away from yan, so the page
 * around it cannot see what is selected in it or where a click fell. Asked
 * for with `?review`, the HTML is given with one script added, served from
 * that same origin so a policy the page sets for itself still lets it run:
 * a right click in the page tells the page around it what was picked, the
 * words selected or else the element under the pointer, by a selector an
 * agent can find it by, and yan's own menu opens there, to comment on it
 * as on any other file. What has been commented on is marked, told back
 * by the page around it. The file itself is never changed, and opened in a
 * tab of its own, without `?review`, it is as the agent wrote it.
 *
 * Shift with the right click leaves the browser's own menu, to inspect.
 */

/** Where the script is, on the files' origin. */
export const REVIEW_SCRIPT_PATH = '_review.js';

export const REVIEW_SCRIPT = `(() => {
  if (window.parent === window) return;
  const say = (m) => parent.postMessage(Object.assign({ yanReview: 1 }, m), '*');
  // A selector of five steps at most, each a tag with its id, which ends it, or its place among its like.
  const selectorOf = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement && parts.length < 5; e = e.parentElement) {
      const tag = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(tag + '#' + CSS.escape(e.id)); break; }
      const like = e.parentElement ? Array.prototype.filter.call(e.parentElement.children, (c) => c.tagName === e.tagName) : [];
      parts.unshift(like.length > 1 ? tag + ':nth-of-type(' + (like.indexOf(e) + 1) + ')' : tag);
    }
    return parts.join(' > ');
  };
  addEventListener('contextmenu', (e) => {
    if (e.shiftKey) return;
    const s = getSelection();
    const range = s && s.rangeCount && !s.isCollapsed ? s.getRangeAt(0) : null;
    const text = range ? s.toString() : '';
    const picked = range !== null && text.trim() !== '';
    let el = picked ? range.commonAncestorContainer : e.target;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el) return;
    e.preventDefault();
    const said = picked ? text : (el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 240);
    say({ kind: 'pick', x: e.clientX, y: e.clientY, selector: selectorOf(el), quote: said, exact: picked ? range.toString() : '' });
  }, true);
  addEventListener('pointerdown', () => say({ kind: 'down' }), true);

  const NAME = 'yan-review';
  const style = document.createElement('style');
  style.textContent = '::highlight(' + NAME + '){background-color:rgba(245,190,60,.4)}[data-yan-review]{outline:2px solid rgba(235,170,40,.95)!important;outline-offset:2px}';
  const rangeOf = (root, exact) => {
    const nodes = [], starts = [];
    let all = '';
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) { nodes.push(n); starts.push(all.length); all += n.data; }
    const at = all.indexOf(exact);
    if (at < 0) return null;
    const place = (o, end) => {
      let i = starts.length - 1;
      while (i > 0 && (starts[i] > o || (end && starts[i] === o))) i--;
      return [nodes[i], Math.min(nodes[i].length, o - starts[i])];
    };
    const r = document.createRange();
    r.setStart.apply(r, place(at, false));
    r.setEnd.apply(r, place(at + exact.length, true));
    return r;
  };
  const mark = (marks) => {
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
    document.querySelectorAll('[data-yan-review]').forEach((el) => el.removeAttribute('data-yan-review'));
    const ranges = [];
    for (const m of marks) {
      let el = null;
      try { el = m.selector ? document.querySelector(m.selector) : null; } catch (_) { el = null; }
      if (m.exact) {
        const r = rangeOf(el || document.body, m.exact) || rangeOf(document.body, m.exact);
        if (r) ranges.push(r);
      } else if (el) el.setAttribute('data-yan-review', '');
    }
    if (typeof Highlight !== 'undefined' && CSS.highlights) CSS.highlights.set(NAME, new Highlight(...ranges));
  };
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.yanReview !== 1 || e.data.kind !== 'marks' || !Array.isArray(e.data.marks)) return;
    mark(e.data.marks);
  });
  const ready = () => say({ kind: 'ready' });
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready);
  else ready();
})();
`;

/** An HTML page with the review's script added, first in its head, or before all of it when it has none. */
export function withReview(html: Buffer): Buffer {
  const text = html.toString('utf8');
  const tag = `<script src="/${REVIEW_SCRIPT_PATH}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(text);
  if (head !== null) return Buffer.from(text.slice(0, head.index + head[0].length) + tag + text.slice(head.index + head[0].length));
  // After the doctype, which must come first for the page to be laid out as it asks.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
  const at = doctype === null ? 0 : doctype[0].length;
  return Buffer.from(text.slice(0, at) + tag + text.slice(at));
}
