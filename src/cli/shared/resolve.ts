import { CommandError } from './errors.js';

/**
 * How a missing option is filled in: a prompt when stdin is a tty, and a
 * refusal naming the flags otherwise, so nothing unattended can hang on one.
 *
 * This is why no option in `src/cli/` is declared required — Commander's own
 * refusal would run before any of this.
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

// Installed by src/cli/yan.ts rather than imported, so a caller that does not
// install one always takes the refusing path.
let installedPrompter: Prompter | undefined;

export function setPrompter(prompter: Prompter | undefined): void {
  installedPrompter = prompter;
}

/** Can a person answer a prompt right now? Asked of stdin only. */
export function isTty(): boolean {
  return process.stdin.isTTY === true;
}

function refuse(missing: readonly OptionSpec[]): never {
  const flags = missing.map((m) => `  ${m.flag} <value>   ${m.describe}`).join('\n');
  throw new CommandError(
    'missing',
    'options',
    `missing required option${missing.length > 1 ? 's' : ''}; pass:\n${flags}`,
    { exitCode: 2 },
  );
}

/**
 * `values` with every spec'd option filled in.
 *
 * @throws CommandError `missing_options` (exit 2) when a value is absent and
 *   there is no prompter or no tty, or the prompt did not fill it in.
 */
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
