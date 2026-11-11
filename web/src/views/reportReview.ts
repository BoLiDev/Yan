import { find, remark } from '../components/review/marks';

/**
 * A report reviewed where it is read. It is drawn in a shadow root, which
 * keeps its style and the page's apart and also keeps what is selected in
 * it from the page's own menu, so the report watches for itself: a right
 * click on words selected in it, or on one of its pictures, says what was
 * picked and where, for the page to open its menu on. Anything else right
 * clicked is the browser's, as is everything with Shift held.
 */

/** What a right click in the report picked: the words, or a picture by what it shows, and where the pointer was. */
export interface ReportPick {
  readonly quote: string;
  /** The words as the report holds them, text nodes end to end: what they are marked by, '' for a picture. */
  readonly exact: string;
  /** Where in the report, as a reader would find it. */
  readonly where: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The report's own style for being reviewed and edited. A comment's words
 * are marked by the page's highlights, coloured here since a shadow root
 * takes no rule from outside. And a text that is edited where it stands
 * has one frame round the line or the paragraph it is in, under the pointer
 * and while it is typed in: such a text is often a span, and a frame drawn
 * round a span that runs over several lines is drawn round each line.
 */
export const REPORT_REVIEW_CSS = `
::highlight(review){background-color:rgba(245,190,60,.42)}
span[data-yan-edit],span[data-yan-reason],span[data-yan-edit]:hover,span[data-yan-reason]:hover,span[data-yan-edit]:focus,span[data-yan-reason]:focus{outline:none}
:has(> span[data-yan-edit]),:has(> span[data-yan-reason]){border-radius:4px;outline:1px dashed transparent;outline-offset:4px;transition:outline-color .12s}
:has(> span[data-yan-edit]:hover),:has(> span[data-yan-reason]:hover){outline-color:#3D3D3D}
:has(> span[data-yan-edit]:focus),:has(> span[data-yan-reason]:focus){outline:1px solid #BCFF2F}
/* given up, a reason's line is not drawn while it has no reason, so it frames nothing */
:has(> span[data-yan-reason]:empty){outline:none}
`;

/** What is selected in the report, when something is: a shadow root's selection is asked for by name. */
function selected(root: ShadowRoot): Range | null {
  const sel = document.getSelection() as (Selection & { getComposedRanges?: (o: { shadowRoots: ShadowRoot[] }) => StaticRange[] }) | null;
  const own = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
  const at: AbstractRange | undefined = sel?.getComposedRanges?.({ shadowRoots: [root] })[0] ?? (own && own.rangeCount > 0 ? own.getRangeAt(0) : undefined);
  if (at === undefined || at.collapsed || !root.contains(at.startContainer) || !root.contains(at.endContainer)) return null;
  const range = document.createRange();
  range.setStart(at.startContainer, at.startOffset);
  range.setEnd(at.endContainer, at.endOffset);
  return range;
}

/** Tell `pick` of each right click in `shell`, the report in `root`, on words selected there or on a picture. */
export function watchPicks(root: ShadowRoot, shell: HTMLElement, pick: (picked: ReportPick) => void): void {
  shell.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) return;
    const range = selected(root);
    const words = range?.toString() ?? '';
    const shot = words.trim() === '' && e.target instanceof Element ? e.target.closest<HTMLImageElement>('figure img') : null;
    const from = words.trim() !== '' && range !== null ? (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement) : shot;
    if (from === null) return;
    e.preventDefault();
    const d = from.closest<HTMLElement>('[data-yan-d]')?.dataset.yanD;
    const where = ['artifacts/report.html', d ? `deliverable ${d}` : '', shot ? `the picture${shot.alt ? ` "${shot.alt}"` : ''}` : ''].filter(Boolean).join(', ');
    pick({ quote: shot ? shot.alt : words, exact: shot ? '' : words, where, x: e.clientX, y: e.clientY });
  });
}

/** What marks, in `shell`, the words each comment on the report is about. */
export function reportMarks(shell: HTMLElement): (exacts: readonly string[]) => void {
  const mine = new Set<Range>();
  return (exacts) => remark(mine, exacts.length ? find(shell, exacts) : []);
}
