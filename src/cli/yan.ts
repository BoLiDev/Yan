import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { isTty } from './shared/tty.js';
import { YanError, isYanError } from '../util/error.js';
import { yanHome, subcommands } from '../util/home.js';
import { readJsonOrNone } from '../util/json.js';
import { asString } from '../util/narrow.js';
import type { NewTask } from './shared/launch.js';

/**
 * The Commander root, and the only place subcommands are composed. A command
 * is a `dist/cli/<name>.js` exporting a `command`, discovered from disk. Bare
 * `yan` is not a command: it picks a task and starts an agent on it
 * (`shared/launch.ts`).
 *
 * No option anywhere under `src/cli/` is declared `.requiredOption()`: a
 * command asks for what is missing when there is a terminal, and Commander
 * would refuse before it got the chance.
 */

/**
 * Read from the package.json beside `dist/`, so the number has one home and a
 * release cannot leave a copy behind. A home without one still gets a working
 * CLI: the version is the least of what `yan --version` is asked for.
 */
function yanVersion(home: string): string {
  return asString(readJsonOrNone(join(home, 'package.json'))?.version) || 'unknown';
}

/** What every subcommand module must export. */
interface CommandModule {
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

async function buildProgram(home: string): Promise<Command> {
  const program = new Command();
  const found = subcommands(home);

  program
    .name('yan')
    .description('notes that outlive an agent session: tasks, their problem, deliverables and log')
    .version(`yan ${yanVersion(home)}`, '-V, --version')
    .enablePositionalOptions()
    .showHelpAfterError()
    .addHelpText(
      'after',
      `
Bare 'yan', at a terminal, picks a task or starts one and runs an agent on it
here, in the task's first worktree when it has any ('yan repo' keeps the
repositories a new task picks from):

  yan [--cli claude|codex|agy] [--task <id> | --new <title> [--repo <name>[:<package>,...]]... | --no-repo] [-- <args for the agent>]

--task goes on with an open task without asking which. --new starts a task
called <title>; --repo names a repository it works in, with the packages it
is about after a colon (the whole repository without), and --no-repo none.
What is not given is asked.`,
    );

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

/** What bare `yan` was given: the CLI to run instead, an open task or a new task's answers, and what to pass the agent. */
interface EntryArgs {
  readonly cli?: string;
  readonly extra: string[];
  readonly new?: NewTask;
  readonly task?: string;
}

/** `name` or `name:package,package`, as `--repo` takes a repository and the packages a new task is about. */
function repoArg(spec: string): { name: string; scope: string[] } {
  const colon = spec.indexOf(':');
  const name = (colon < 0 ? spec : spec.slice(0, colon)).trim();
  if (name === '') throw YanError.usage('yan_usage', `--repo takes a repository's name, as in --repo app or --repo app:packages/web - not '${spec}'`);
  const scope = colon < 0 ? [] : spec.slice(colon + 1).split(',').map((p) => p.trim()).filter((p) => p !== '');
  return { name, scope };
}

/**
 * `argv` as bare `yan`'s, or `undefined` when it names a command or asks for
 * help or the version.
 *
 * @throws YanError `yan_usage` for a flag bare `yan` does not take.
 */
function entryArgs(argv: readonly string[]): EntryArgs | undefined {
  const first = argv[0];
  if (first !== undefined && (!first.startsWith('-') || ['-h', '--help', '-V', '--version'].includes(first))) return undefined;
  let cli: string | undefined;
  let task: string | undefined;
  let title: string | undefined;
  let repos: { name: string; scope: string[] }[] | undefined;
  let noRepo = false;
  let extra: string[] = [];
  // `--flag value` or `--flag=value`; the value, and how many words it took.
  const valueOf = (flag: string, i: number): [string, number] | undefined => {
    const word = argv[i] as string;
    if (word === flag && argv[i + 1] !== undefined) return [argv[i + 1] as string, 2];
    return word.startsWith(`${flag}=`) ? [word.slice(flag.length + 1), 1] : undefined;
  };
  for (let i = 0; i < argv.length;) {
    const word = argv[i] as string;
    if (word === '--') {
      extra = argv.slice(i + 1);
      break;
    }
    const given = valueOf('--cli', i) ?? valueOf('--task', i) ?? valueOf('--new', i) ?? valueOf('--repo', i);
    if (given !== undefined && word.startsWith('--cli')) cli = given[0];
    else if (given !== undefined && word.startsWith('--task')) task = given[0];
    else if (given !== undefined && word.startsWith('--new')) title = given[0];
    else if (given !== undefined) (repos ??= []).push(repoArg(given[0]));
    else if (word === '--no-repo') noRepo = true;
    else throw YanError.usage('yan_usage', `bare yan takes --cli <name>, --task <id> or --new <title> with --repo <name> or --no-repo, and, after --, arguments for the agent - not '${word}'`);
    i += given?.[1] ?? 1;
  }
  if (title === undefined && (repos !== undefined || noRepo)) throw YanError.usage('yan_usage', '--repo and --no-repo are a new task\'s, given with --new <title>');
  if (repos !== undefined && noRepo) throw YanError.usage('yan_usage', '--repo and --no-repo say opposite things; give one');
  if (task !== undefined && title !== undefined) throw YanError.usage('yan_usage', '--task goes on with a task and --new starts one; give one');
  const made = title === undefined ? {} : { new: { title, ...(noRepo ? { repos: [] } : repos === undefined ? {} : { repos }) } };
  return { ...(cli === undefined ? {} : { cli }), extra, ...made, ...(task === undefined ? {} : { task }) };
}

async function main(argv: readonly string[]): Promise<number> {
  const program = await buildProgram(yanHome());

  try {
    const entry = entryArgs(argv);
    if (entry !== undefined) {
      // Without a terminal there is nobody to pick a task or talk to an agent.
      if (!isTty()) {
        if (argv.length > 0) throw YanError.usage('yan_usage', 'bare yan starts an agent, and needs a terminal to do it');
        program.outputHelp();
        return 0;
      }
      const { enter } = await import('./shared/launch.js');
      return await enter(entry);
    }

    await program.parseAsync([...argv], { from: 'user' });
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
