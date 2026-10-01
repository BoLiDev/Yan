import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { addLearning, listLearnings } from '../records/learnings/index.js';

/**
 * `yan learn` — learnings: what `user` asked to keep beyond one task. An
 * agent writes one only when `user` asks it to, and writes what was
 * discussed, not a lesson of its own.
 */

const add = new Command('add')
  .description('create learnings/<name>.md and print its path; write the text into that file')
  .argument('<name>', 'the topic, which names the file')
  .option('--description <text>', 'required: one line saying when it applies')
  .action(
    action('yan learn add', (name: string, options: { description?: string }) => {
      out(addLearning(name, options.description ?? ''));
    }),
  );

const ls = new Command('ls')
  .description('every learning: its name, when it applies, and its file')
  .action(
    action('yan learn ls', () => {
      const all = listLearnings();
      if (all.length === 0) {
        out('no learnings');
        return;
      }
      for (const l of all) {
        out(`${l.name}${l.description === '' ? '' : ` - ${l.description}`}`);
        out(`  ${l.path}`);
      }
    }),
  );

export const command = new Command('learn')
  .description('save a learning - only when the user asks for one')
  .addCommand(add)
  .addCommand(ls);
