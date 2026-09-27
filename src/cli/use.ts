import { Command } from 'commander';
import { action } from './shared/action.js';
// The one command that imports another: an alias is `yan vault use` by definition.
import { useVault } from './vault.js';

/** `yan use <name>` — the alias for `yan vault use`, sharing its implementation. */
export const command = new Command('use')
  .description('switch the active vault (alias for `yan vault use`)')
  .argument('[name]')
  .action(action('yan use', (name: string | undefined) => { useVault(name); }));
