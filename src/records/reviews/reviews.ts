import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { YanError } from '../../util/error.js';
import { normalizePath } from '../../util/paths.js';
import { localStamp } from '../../util/time.js';
import { refuseWhileUnfinished, taskDir } from '../../util/vault.js';

/**
 * A review: what `user` said of a task's files and branches as they read
 * them on `yan serve`'s page, gathered there a comment at a time and
 * written here once they are through, a Markdown file an agent reads whole,
 * here or wherever the vault is cloned. Each is a file of its own in
 * `tasks/<id>/reviews/`, named for the moment it was written, in UTC, so
 * the newest sorts last on every machine; none is edited after: what an
 * agent made of it is in its answer and the work, and the next review is
 * another file.
 */

/** One thing said: of what, the words it is about as they were selected, and what `user` says of them. */
export interface ReviewComment {
  /** Where it is, as a reader would find it: `artifacts/docs/design.md, line 12`. */
  readonly where: string;
  /** What was selected, as it read; '' when the comment is on the place as a whole. */
  readonly quote: string;
  readonly text: string;
  /** The quote is code, kept in a fence, its lines as they were. */
  readonly code?: boolean;
}

export interface Review {
  /** What `user` says of it all, last; '' for none. */
  readonly summary: string;
  readonly comments: readonly ReviewComment[];
}

/** The most comments one review holds. */
export const REVIEW_MOST = 500;

const NAME = /^\d{8}-\d{6}(-\d+)?\.md$/;

function dirOf(taskId: string): string {
  return normalizePath(join(taskDir(taskId), 'reviews'));
}

/** A fence no run of backticks in `text` closes. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

function quoted(c: ReviewComment): string[] {
  const quote = c.quote.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (quote.trim() === '') return [];
  if (c.code === true) {
    const f = fence(quote);
    return [f, quote, f, ''];
  }
  return [...quote.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)), ''];
}

/** A review as its file says it: the overall words first, then each comment under where it is, numbered to be answered by. */
export function reviewText(taskId: string, review: Review, at: Date): string {
  const lines = [`# Review of ${taskId}, ${localStamp(at)}`, ''];
  const summary = review.summary.trim();
  if (summary !== '') lines.push(summary, '');
  review.comments.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.where.replace(/\s+/g, ' ').trim()}`, '', ...quoted(c), c.text.trim(), '');
  });
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Write a review of the task, and say which file it is, by its name and
 * its path from the vault's root.
 *
 * @throws YanError `review_usage` for one that says nothing.
 */
export function writeReview(taskId: string, review: Review, at: Date = new Date()): { name: string; path: string; file: string } {
  if (review.summary.trim() === '' && review.comments.length === 0) throw YanError.usage('review_usage', 'a review says something: a comment, or a word on it all');
  if (review.comments.length > REVIEW_MOST) throw YanError.usage('review_usage', `a review holds ${REVIEW_MOST} comments at most`);
  if (review.comments.some((c) => c.text.trim() === '' || c.where.trim() === '')) throw YanError.usage('review_usage', 'every comment says something, of somewhere');
  refuseWhileUnfinished();
  const dir = dirOf(taskId);
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  let name = `${stamp}.md`;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${stamp}-${n}.md`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), reviewText(taskId, review, at));
  } catch (cause) {
    throw new YanError('review_failed', `cannot write ${join(dir, name)}`, { cause });
  }
  return { name, path: `tasks/${taskId}/reviews/${name}`, file: normalizePath(join(dir, name)) };
}

/** The task's reviews by name, oldest first; none when it has had none. */
export function listReviews(taskId: string): string[] {
  try {
    // By their names less the ending, so the second of one moment follows the first.
    return readdirSync(dirOf(taskId)).filter((n) => NAME.test(n)).map((n) => n.slice(0, -3)).sort().map((n) => `${n}.md`);
  } catch {
    return [];
  }
}

/** One review, the newest unless named, `.md` or not: its name, its file and what it says; undefined when there is none. */
export function readReview(taskId: string, name?: string): { name: string; file: string; text: string } | undefined {
  const all = listReviews(taskId);
  const wanted = name === undefined ? all.at(-1) : all.find((n) => n === name || n === `${name}.md`);
  if (wanted === undefined) return undefined;
  const file = normalizePath(join(dirOf(taskId), wanted));
  try {
    return { name: wanted, file, text: readFileSync(file, 'utf8') };
  } catch {
    return undefined;
  }
}
