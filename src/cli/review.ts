import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { requiredTask } from './shared/task-id.js';
import { listReviews, readReview } from '../records/reviews/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan review` — what `user` said of the task's files and branches in their
 * last review, as they wrote it on yan serve's page: a word on it all, then
 * each comment under where it is, with what was selected. Reviews are the
 * user's, written by the page alone; an agent reads them here.
 */
export const command = new Command('review')
  .description("the user's last review of the task's files and branches, written on yan serve's page: read it when they say they reviewed, and answer every comment")
  .argument('[name]', 'an earlier review, by its name; without, the newest')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .option('--list', 'every review by name, oldest first')
  .option('--json', 'as JSON: { name, file, text }, null when there is none; with --list, the names')
  .addHelpText(
    'after',
    `
A review is a Markdown file in the task's reviews/ folder, named for when it
was written. Its comments are numbered: say what came of each by its number.
Nothing here marks one read or answered, and a review is never edited: what
came of it is in your answer and the work.

  yan review                    # the newest
  yan review --list
  yan review 20261111-140312    # an earlier one`,
  )
  .action(
    action('yan review', (name: string | undefined, options: { task?: string; list?: boolean; json?: boolean }) => {
      const task = requiredTask(options.task, '--task <id>');
      if (options.list === true) {
        const names = listReviews(task.id);
        if (options.json === true) out(JSON.stringify(names));
        else if (names.length === 0) out('no review yet');
        else for (const n of names) out(n);
        return;
      }
      const review = readReview(task.id, name);
      if (review === undefined && name !== undefined) throw YanError.usage('review_usage', `${task.id} has no review ${name} - yan review --list names them`);
      if (options.json === true) out(JSON.stringify(review ?? null));
      else if (review === undefined) out('no review yet');
      else {
        out(`(${review.file})`);
        out(review.text.replace(/\n+$/, ''));
      }
    }),
  );
