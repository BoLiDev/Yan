import { CommandError } from './errors.js';

/**
 * The soft/hard rule, expressed once instead of per command
 * (runtime.md §3, cli-ux.md §1).
 *
 *   soft   stdin is a TTY  AND  a required value is missing  → prompt
 *   hard   every required flag is present, OR there is no TTY → no prompts.
 *          Missing values with no TTY is a REFUSAL that names the flags.
 *
 * The refusal is the important half. A script, a hook or an agent that reached
 * a prompt would hang forever with nobody to answer it, so "there is no TTY" is
 * checked before "a value is missing", and it always wins.
 *
 * Commander's own reaction to a missing `.requiredOption()` is to print an
 * error and exit, which would run *before* any of this. That is why no option
 * in `src/cli/` is ever declared required: every option is optional to
 * Commander and the action handler calls this instead.
 */

export interface OptionSpec {
  /** The key Commander parses the value into, e.g. `task`. */
  readonly name: string;
  /** The flag as a person types it, e.g. `--task`. */
  readonly flag: string;
  /** One line. Used by the prompt and by the refusal alike. */
  readonly describe: string;
}

export type Prompter = (missing: readonly OptionSpec[]) => Promise<Record<string, string>>;

// The prompter is *installed*, never imported here: `src/ui/` is Clack and
// people, and a seam or a store must never be able to reach it
// (runtime.md §2). Phase 8 installs it from src/cli/yan.ts; until then the
// soft path simply does not exist and every caller takes the hard one.
let installedPrompter: Prompter | undefined;

export function setPrompter(prompter: Prompter | undefined): void {
  installedPrompter = prompter;
}

/**
 * Can a person answer a prompt right now?
 *
 * stdin only. stdout is often a pipe even for a person (`yan ls | less`), and
 * it is stdin that a prompt reads from.
 */
export function isTty(): boolean {
  return process.stdin.isTTY === true;
}

function refuse(missing: readonly OptionSpec[]): never {
  const flags = missing.map((m) => `  ${m.flag} <value>   ${m.describe}`).join('\n');
  throw new CommandError(
    'missing',
    'options',
    `missing required option${missing.length > 1 ? 's' : ''}; pass:\n${flags}`,
    // Exit 2: not enough was passed, which is the caller's mistake. The code
    // stays `missing_options` rather than `<command>_usage` because it is the
    // one usage failure that is not about a particular command.
    { exitCode: 2 },
  );
}

export async function resolve<T extends Record<string, string | undefined>>(
  values: T,
  spec: readonly OptionSpec[],
): Promise<T & Record<string, string>> {
  const missing = spec.filter((s) => {
    const v = values[s.name];
    return v === undefined || v === '';
  });

  if (missing.length === 0) {
    return values as T & Record<string, string>;
  }
  if (!isTty() || installedPrompter === undefined) {
    refuse(missing);
  }

  const answers = await installedPrompter(missing);
  const filled = { ...values, ...answers };
  const stillMissing = missing.filter((s) => {
    const v = filled[s.name];
    return v === undefined || v === '';
  });
  if (stillMissing.length > 0) refuse(stillMissing);

  return filled as T & Record<string, string>;
}
