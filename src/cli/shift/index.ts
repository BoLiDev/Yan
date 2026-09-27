import { Command } from 'commander';
import { newShift } from './new.js';
import { doneShift } from './done.js';
import { shiftAbandonCommand } from './abandon.js';

/**
 * `yan shift` — `new` dispatches (`new.ts`, with the work order in
 * `brief.ts`), `done` clocks out (`done.ts`), and `abandon` gives one up
 * (`abandon.ts`).
 */
export const command = new Command('shift')
  .description('dispatch, clock out and abandon shifts')
  .addCommand(newShift)
  .addCommand(doneShift)
  .addCommand(shiftAbandonCommand);
