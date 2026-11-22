import type { EntryChain } from './launch.js';

/**
 * The steps bare `yan` draws on its chain, as plain lines on stderr: for a
 * command an agent runs, where nothing is asked and nothing drawn, and
 * stdout is kept for what the command answers.
 */
export const plainChain: EntryChain = {
  begin: () => undefined,
  working: () => ({
    update: () => undefined,
    finish: (said) => plainChain.say(said),
  }),
  say: (said) => {
    for (const line of [said.line, ...(said.detail ?? []).map((d) => `  ${d}`)]) process.stderr.write(`${line}\n`);
  },
  end: () => undefined,
};
