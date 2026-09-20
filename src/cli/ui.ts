import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { YanError } from '../util/error.js';
import { machineDir } from '../util/machine.js';
import { action, out } from './shared/action.js';
import { openPath } from './shared/opener.js';
import { collectReport, localDay, type ReportRange } from './ui/collect.js';
import { reportPage } from './ui/page.js';

/**
 * `yan ui [--since <date>] [--until <date>] [--out <file>] [--no-open] [--json]`
 * — a work report of every task: what was done and what is left, collected
 * from the task files with no AI. It writes one self-contained page from
 * `templates/ui/report.html`, prints its path and opens it; `--json` prints
 * the object the page is written from (`ui/collect.ts`) and writes nothing.
 *
 * The page is build output, so it goes to the machine directory rather than
 * the vault, which is versioned and pushed: `~/.yan/ui/report.html`, one file
 * overwritten each run.
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
  .option('--out <file>', 'write the page there instead of ~/.yan/ui/report.html')
  .option('--no-open', 'write the page and print its path, but do not open it')
  .option('--json', 'print the report data, version 3, and write nothing')
  .action(
    action('ui', (options: { since?: string; until?: string; out?: string; open: boolean; json?: boolean }) => {
      const since = day('--since', options.since);
      const until = day('--until', options.until);
      if (since !== null && until !== null && since > until) {
        throw YanError.usage('ui_usage', `--since ${since} is after --until ${until}`);
      }
      const range: ReportRange | null = since === null && until === null ? null : { since, until };
      const report = collectReport(range);
      if (options.json === true) {
        out(JSON.stringify(report));
        return;
      }

      const page = reportPage(report);
      const file = options.out !== undefined ? resolve(options.out) : join(machineDir(), 'ui', 'report.html');
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, page);
      } catch (err) {
        throw new YanError('ui_write', `cannot write ${file}: ${(err as Error).message}`);
      }
      out(file);
      if (options.open) openPath(file);
    }),
  );
