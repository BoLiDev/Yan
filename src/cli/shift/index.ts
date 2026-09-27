import { Command } from 'commander';
import { shiftAbandonCommand } from '../abandon.js';
import { newShift } from './new.js';
import { doneShift } from './done.js';

/**
 * `yan shift` — `new` dispatches (`new.ts`, with the work order in
 * `brief.ts`), `done` clocks out (`done.ts`), and `abandon` lives with
 * `yan abandon` in `../abandon.ts`.
 */
export const command = new Command('shift')
  .description('dispatch, clock out and abandon shifts')
  .addCommand(newShift)
  .addCommand(doneShift)
  .addCommand(shiftAbandonCommand);
