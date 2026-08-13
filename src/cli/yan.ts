import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { queueJson } from './ls.js';
import { isTty, setPrompter } from './shared/resolve.js';
import { isYanError } from '../util/error.js';
import { yanHome, subcommands } from '../util/home.js';

/**
 * The Commander root, and the only place subcommands are composed. A command
 * is a `dist/cli/<name>.js` exporting a `command`, discovered from disk.
 *
 * No option anywhere under `src/cli/` may be declared `.requiredOption()`:
 * Commander would exit before `shared/resolve.ts` could ask for it.
 */

export const YAN_VERSION = '0.1.0';

/** What every ported subcommand module must export. */
export interface CommandModule {
  readonly command: Command;
}

function hasCommand(mod: unknown): mod is CommandModule {
  return (
    typeof mod === 'object' &&
    mod !== null &&
    'command' in mod &&
    (mod as { command: unknown }).command instanceof Command
  );
}

/**
 * Rewrite a leading `<a> <b>` into `<a>-<b>` when a command of that name
 * exists, so `yan shift new` and `yan shift-new` are the same. Argv that does
 * not name one is untouched.
 */
export function joinTwoWordCommand(argv: readonly string[], known: readonly string[]): string[] {
  const [first, second, ...rest] = argv;
  if (first === undefined || second === undefined) return [...argv];
  if (/^[A-Za-z0-9_-]+$/.test(second) && known.includes(`${first}-${second}`)) {
    return [`${first}-${second}`, ...rest];
  }
  return [...argv];
}

export async function buildProgram(home: string): Promise<Command> {
  const program = new Command();
  const found = subcommands(home);

  program
    .name('yan')
    .description('one main agent per task, orchestrating single-use shifts')
    .version(`yan ${YAN_VERSION}`, '-V, --version')
    .enablePositionalOptions()
    .showHelpAfterError();

  for (const name of found) {
    const file = join(home, 'dist', 'cli', `${name}.js`);
    const mod: unknown = await import(pathToFileURL(file).href);
    if (hasCommand(mod)) {
      program.addCommand(mod.command);
    } else {
      // Loud, and the command is simply absent.
      process.stderr.write(`yan: dist/cli/${name}.js exports no \`command\`\n`);
    }
  }

  refuseToExit(program);
  return program;
}

/**
 * Make Commander throw instead of exiting, for every command in the tree —
 * `addCommand` does not inherit it — so `main` can map its refusals onto exit
 * 2 like every other "you called this wrongly".
 */
function refuseToExit(command: Command): void {
  command.exitOverride();
  for (const sub of command.commands) refuseToExit(sub);
}

/** The codes Commander throws for `--help` and `--version`, which are not mistakes. */
const COMMANDER_INFORMATIONAL = new Set([
  'commander.help',
  'commander.helpDisplayed',
  'commander.version',
]);

function commanderExitCode(err: CommanderError): number {
  return COMMANDER_INFORMATIONAL.has(err.code) ? err.exitCode : 2;
}

/** One row of the select bare `yan` shows on a terminal. */
export interface EntryChoice {
  readonly id: string;
  readonly title: string;
  readonly units: number;
  readonly shifts: number;
}

/** The rows that select offers: every task in the queue not yet complete. */
export function liveTaskChoices(): EntryChoice[] {
  const queue = queueJson() as {
    tasks: { id: string; title: string; complete: boolean; units: unknown[]; shifts: number }[];
  };
  return queue.tasks
    .filter((t) => !t.complete)
    .map((t) => ({ id: t.id, title: t.title, units: t.units.length, shifts: t.shifts }));
}

/** The argv the chosen entry point becomes, re-entering this same program. */
async function chooseEntryPoint(): Promise<string[]> {
  const { chooseEntry, CREATE_NEW } = await import('../ui/prompts.js');
  const { readVaultJson, vaultDirIfAny } = await import('../util/vault.js');
  const dir = vaultDirIfAny();
  const chosen = await chooseEntry(liveTaskChoices(), dir === undefined ? '' : readVaultJson(dir).name);
  return chosen === CREATE_NEW ? ['task', 'new'] : ['continue', '--task', chosen];
}

/**
 * Give `resolve()` its prompter. The import is dynamic, so no path that never
 * prompts loads the prompt library.
 */
function installPrompter(): void {
  setPrompter(async (missing) => {
    const { askFor } = await import('../ui/prompts.js');
    return askFor(missing);
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const home = yanHome();
  const found = subcommands(home);
  const program = await buildProgram(home);
  installPrompter();

  let words = [...argv];

  try {
    // Bare `yan` is the select on a terminal, and usage with exit 0 without.
    if (words.length === 0) {
      if (!isTty()) {
        program.outputHelp();
        return 0;
      }
      words = await chooseEntryPoint();
    }

    await program.parseAsync([...joinTwoWordCommand(words, found)], { from: 'user' });
    // A subcommand that set an exit code of its own keeps it: `yan wait`'s
    // 124, 3 and 4 are answers rather than errors.
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander has already written the message and, on an error, the help.
      return commanderExitCode(err);
    }
    if (isYanError(err)) {
      process.stderr.write(`yan: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}

const invokedDirectly = process.argv[1] !== undefined && /[\\/]yan\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`yan: ${message}\n`);
      process.exitCode = 1;
    });
}
