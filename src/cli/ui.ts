import { Command } from 'commander';
import { YanError } from '../util/error.js';
import { action, out } from './shared/action.js';
import { collectReport, localDay, type ReportRange } from './ui/collect.js';

/**
 * `yan ui [--since <date>] [--until <date>] --json` — a work report of every
 * task: what was done and what is left, collected from the task files with no
 * AI. `--json` prints the object the page is written from (`ui/collect.ts`).
 *
 * The dates only set the range the report opens on; every task is in it
 * whatever they say. Words such as "the past month" are for the caller to turn
 * into two dates: nothing here parses them.
 */

/** A local `YYYY-MM-DD` that names a real day, or a usage error naming the flag. */
function day(flag: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const real = m !== null && localDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) === value;
  if (!real) throw YanError.usage('ui_usage', `${flag} takes a date as YYYY-MM-DD, not '${value}'`);
  return value;
}

export const command = new Command('ui')
  .description('a work report of every task, done and not done, by date range')
  .option('--since <date>', 'the first day the report opens on, YYYY-MM-DD')
  .option('--until <date>', 'the last day the report opens on, YYYY-MM-DD; today without it')
  .option('--json', 'print the report data, version 2, and write nothing')
  .action(
    action('ui', (options: { since?: string; until?: string; json?: boolean }) => {
      const since = day('--since', options.since);
      const until = day('--until', options.until);
      if (since !== null && until !== null && since > until) {
        throw YanError.usage('ui_usage', `--since ${since} is after --until ${until}`);
      }
      const range: ReportRange | null = since === null && until === null ? null : { since, until };
      if (options.json !== true) {
        throw new YanError('ui_no_page', 'the page is not built yet - pass --json for the data');
      }
      out(JSON.stringify(collectReport(range)));
    }),
  );
