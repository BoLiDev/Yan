import { lazy, Suspense } from 'react';
import { useReview } from '../../state/review';

const Panel = lazy(() => import('./ReviewPanel').then((m) => ({ default: m.ReviewPanel })));
const Box = lazy(() => import('./CommentBox').then((m) => ({ default: m.CommentBox })));

/**
 * A review's parts over the page, its button and box and the box a comment
 * is written in, loaded once there is something of a review to show: a
 * comment being written, one kept, or a review just written. Most visits
 * to the page comment on nothing.
 */
export function Review() {
  const any = useReview((s) => s.drafting !== null || s.open !== null || Object.keys(s.written).length > 0 || Object.values(s.comments).some((list) => list.length > 0));
  if (!any) return null;
  return (
    <Suspense fallback={null}>
      <Panel />
      <Box />
    </Suspense>
  );
}
