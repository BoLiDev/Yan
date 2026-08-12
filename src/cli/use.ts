import { Command } from 'commander';
import { action } from './shared/action.js';
import { useVault } from './vault.js';

/**
 * `yan use <name>` — the alias for `yan vault use`.
 *
 * It exists because it is the one a person types while thinking about
 * something else, and four words is three too many for that. Everything else
 * stays under the `vault` noun so `yan --help` reads as a shape rather than a
 * pile; this is the single exception, and it shares the implementation rather
 * than repeating it, so the two spellings cannot drift.
 */
export const command = new Command('use')
  .description('switch the active vault (alias for `yan vault use`)')
  .argument('[name]')
  .action(action('use', (name: string | undefined) => { useVault(name); }));
