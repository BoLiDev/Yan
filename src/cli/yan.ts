import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { queueJson } from './ls.js';
import { isTty, setPrompter } from './shared/resolve.js';
import { isYanError } from '../util/error.js';
import { yanHome, subcommands } from '../util/home.js';

/**
 * The Commander root (runtime.md §3).
 *
 * `bin/yan` reaches this file, and this file is the *only* place that composes
 * subcommands. Three things it buys, all of them things the shell dispatcher
 * could not do:
 *
 *   - `yan --help` is generated rather than hand-maintained, so it cannot drift
 *     from the real flags;
 *   - `yan shift new` is a command with a subcommand, not the filename trick
 *     `bin/yan` had to play (rewriting a space into a hyphen);
 *   - flags are declared once instead of parsed by hand twenty times.
 *
 * During the migration the command list has two halves. A ported command is a
 * `dist/cli/<name>.js` exporting a `command`; an unported one is a
 * `bin/yan-<name>.sh`. Both are DISCOVERED, never tabulated — the same rule the
 * shell dispatcher had, and for the same reason: phases land in parallel and a
 * central list would make every one of them conflict in this file. It is also
 * what keeps `bin/yan`'s "is this ported?" test (does `dist/cli/<name>.js`
 * exist) exactly true rather than approximately true.
 *
 * NOTE, and it is the rule most easily broken: **no option anywhere under
 * `src/cli/` is ever declared `.requiredOption()`.** Commander would exit before
 * the soft path could ask. Validation belongs to the action handler, via
 * `support/resolve.ts`.
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

/** Run a `bin/yan-*.sh` and inherit its stdio, exit status and all. */
function runShellSubcommand(home: string, name: string, args: readonly string[]): never {
  const script = join(home, 'bin', `yan-${name}.sh`);
  // bash explicitly rather than via the shebang: on Windows the script is not
  // an executable file as far as CreateProcess is concerned, and Node does not
  // read shebangs.
  const r = spawnSync('bash', [script, ...args], {
    stdio: 'inherit',
    env: { ...process.env, YAN_HOME: home },
    windowsHide: true,
  });
  if (r.error) {
    process.stderr.write(`yan: cannot run ${script}: ${r.error.message}\n`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

/**
 * `yan shift new` and `yan shift-new` must reach the same place.
 *
 * The shell dispatcher did this by rewriting the space into a hyphen before
 * looking for a file. Commander cannot see two words as one command name, so
 * the same rewrite happens here, once, before parsing — and only when the
 * hyphenated name actually exists, so a real `yan ls t042` is untouched.
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

  for (const name of found.ported) {
    const file = join(home, 'dist', 'cli', `${name}.js`);
    const mod: unknown = await import(pathToFileURL(file).href);
    if (hasCommand(mod)) {
      program.addCommand(mod.command);
    } else {
      // A ported file that exports no command is a bug in the port, not a
      // runtime condition. Say so and let the shell half answer, if it is
      // still there.
      process.stderr.write(`yan: dist/cli/${name}.js exports no \`command\`\n`);
    }
  }

  for (const name of found.shell) {
    if (found.ported.includes(name)) continue;
    program
      .command(name)
      .description(`(shell) bin/yan-${name}.sh`)
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false)
      .argument('[args...]')
      .action((args: string[]) => {
        runShellSubcommand(home, name, args);
      });
  }

  refuseToExit(program);
  return program;
}

/**
 * Commander's own argument errors exit 2, like every other "you called this
 * wrongly" in yan.
 *
 * The exit-code contract is the MVP's and it is what a caller reads: 0 fine, 2
 * YOU CALLED THIS WRONGLY, 1 it did not work — plus the handful of per-command
 * codes above that. Commander's default is 1 for everything it rejects, so
 * until now `yan tree get --nonsense` and `yan tree get` with no `--repo`
 * disagreed about what the same class of mistake was worth: one was Commander's
 * refusal, the other was `resolve()`'s.
 *
 * Which way, and why THIS way: 2 is the one an agent can act on. A shift
 * reading `1` learns only that something went wrong and has to parse prose to
 * find out whether to fix its command line or escalate; `2` says the command
 * line was wrong before anything happened, and nothing was done. Moving yan's
 * twenty hand-written usage refusals down to 1 would have made them agree just
 * as well and thrown that away.
 *
 * `exitOverride` is what makes it reachable: without it Commander calls
 * `process.exit` itself, before `main` has any say. It is applied to every
 * command in the tree because `addCommand` — which is how every ported
 * subcommand arrives — does not inherit it.
 */
function refuseToExit(command: Command): void {
  command.exitOverride();
  for (const sub of command.commands) refuseToExit(sub);
}

/** `--help` and `--version` are not mistakes: Commander throws for those too. */
const COMMANDER_INFORMATIONAL = new Set([
  'commander.help',
  'commander.helpDisplayed',
  'commander.version',
]);

function commanderExitCode(err: CommanderError): number {
  return COMMANDER_INFORMATIONAL.has(err.code) ? err.exitCode : 2;
}

/**
 * Bare `yan` on a terminal (cli-ux.md §2).
 *
 *     › create new task
 *       t042  unify the auth header          2 shifts live
 *       t041  gateway retry budget           idle
 *
 * DERIVED, NEVER STORED: the list is the same scan `yan ls` already does over
 * `tasks/*​/task.json`, so there is no menu configuration file and nothing that
 * can disagree with the directory. If `yan ls` can render it, the select can
 * offer it.
 *
 * The choice becomes a command line and re-enters the same program, which is
 * why this is a few lines: choosing a task IS `yan continue --task <id>`, and
 * choosing to create IS `yan task new` with nothing filled in, which then walks
 * its own prompts.
 */
export interface EntryChoice {
  readonly id: string;
  readonly title: string;
  readonly units: number;
  readonly shifts: number;
}

/** The rows of that select, separated from the drawing of it so a test can see them. */
export function liveTaskChoices(): EntryChoice[] {
  const queue = queueJson() as {
    tasks: { id: string; title: string; complete: boolean; units: unknown[]; shifts: number }[];
  };
  return queue.tasks
    .filter((t) => !t.complete)
    .map((t) => ({ id: t.id, title: t.title, units: t.units.length, shifts: t.shifts }));
}

async function chooseEntryPoint(): Promise<string[]> {
  const { chooseEntry, CREATE_NEW } = await import('../ui/prompts.js');
  const chosen = await chooseEntry(liveTaskChoices());
  return chosen === CREATE_NEW ? ['task', 'new'] : ['continue', '--task', chosen];
}

/**
 * The soft path, installed rather than imported (runtime.md §2–3).
 *
 * `resolve()` calls this only when stdin is a TTY and a required value is
 * missing, so the dynamic import is what keeps Clack off every other path —
 * including every path a hook takes.
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
    // Bare `yan` with a person at the keyboard is the select. Without a TTY it
    // prints usage and exits 0, unchanged, so scripts and agents see no
    // difference — and it is not an unknown command, so it is not an error.
    if (words.length === 0) {
      if (!isTty()) {
        program.outputHelp();
        return 0;
      }
      words = await chooseEntryPoint();
    }

    await program.parseAsync([...joinTwoWordCommand(words, found.all)], { from: 'user' });
    // A subcommand that ended with a status of its own keeps it. `yan wait` is
    // the first: 124 for a quiet slice, 3 for nothing left to supervise, 4 for
    // "somebody else is already on duty" — none of them an error, so none of
    // them a thrown YanError, and returning 0 unconditionally here would erase
    // the whole contract.
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
