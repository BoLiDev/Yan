import { Command, Option } from 'commander';
import { action, out } from './shared/action.js';
import { terminalWidth } from './shared/style.js';
import { overview, STATUS_FILTERS, type StatusFilter } from './overview/overview.js';
import { renderOverview } from './overview/render.js';

/**
 * `yan ls [--status open|done|all] [--json]` — the queue, produced by scanning
 * `tasks/*​/task.json` on every call. Stores nothing. One task in depth is
 * `yan show <id>`: two commands printing the same thing is two commands to
 * keep in step.
 *
 * What it prints is the overview in `overview/overview.ts`, as
 * `overview/render.ts` lays it out; `--json` is the same overview, version 2.
 */

export const command = new Command('ls')
  .description('what you are working on: a card per open task, a line per done one')
  .addOption(new Option('--status <status>', 'which tasks: open, done (abandoned included) or all').choices(STATUS_FILTERS).default('open'))
  .option('--json', 'machine readable output: version 2, the overview')
  .addHelpText(
    'after',
    `
One task in depth is 'yan show <id>'.`,
  )
  .action(
    action('yan ls', (options: { json?: boolean; status: StatusFilter }) => {
      const now = new Date();
      const found = overview(options.status, { now });
      if (options.json === true) out(JSON.stringify(found));
      else for (const line of renderOverview(found, { now, cols: terminalWidth() })) out(line);
    }),
  );
