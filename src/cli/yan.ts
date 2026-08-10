import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
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

  return program;
}

export async function main(argv: readonly string[]): Promise<number> {
  const home = yanHome();
  const found = subcommands(home);
  const program = await buildProgram(home);

  // Bare `yan` prints the list and exits 0: it is not an unknown command, so it
  // is not an error. (Phase 8 replaces this with the select — cli-ux.md.)
  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync([...joinTwoWordCommand(argv, found.all)], { from: 'user' });
    return 0;
  } catch (err) {
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
