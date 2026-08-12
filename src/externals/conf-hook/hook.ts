import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { hooksDir } from '../../util/vault.js';
import { bashCommand } from '../../util/bash.js';
import { HookError } from './errors.js';

/**
 * The calling protocol for the hooks directory — the TypeScript half of
 * `bin/lib-hook.sh` (boundaries.md §10, architecture.md §4.3).
 *
 * THIS IS THE ONLY PLACE ALLOWED TO EXECUTE ANYTHING IN THAT DIRECTORY. That is
 * the whole reason it is a module of its own: `<vault>/hooks/` holds `user`'s
 * own executables, they are not part of yan, and there has to be exactly one
 * door through which yan asks them a question.
 *
 * The protocol is deliberately asymmetric:
 *
 *   input   JSON on stdin   so fields can be added later without breaking an
 *                           existing hook
 *   output  ONE LINE on stdout
 *
 * THE THREE OUTCOMES, and why they are three and not two:
 *
 *   no such hook       NOT an error. It means "no outside authority is
 *                      configured here", and the caller falls back to its own
 *                      default. `callHook` returns `undefined`.
 *   hook exits 0       its answer is the LAST non-empty line of stdout. Last,
 *                      not first: §10 lets a hook create or register the branch
 *                      itself as long as it prints the name at the end, so
 *                      anything the creation step chattered about comes before.
 *   hook exits non-0   a `HookError` with code `hook_refused`. The caller must
 *                      stop. It must NEVER fall back to the built-in default:
 *                      after the team's own tooling has refused, quietly
 *                      inventing a branch name that breaks their rules — and
 *                      may not be mergeable at all — is much worse than failing
 *                      outright.
 *
 * A REFUSAL IS AN ANSWER, SO IT IS CARRIED. The hook's stderr used to be
 * inherited — it reached the terminal and stopped there, which is fine for a
 * person watching a pane and useless everywhere else: the thrown error carried
 * only "exit 3", the agent reading it learned nothing, and under `--json` the
 * hook's prose landed in the middle of the stream. It is captured now and put
 * into the `HookError`, so the reason travels with the refusal.
 *
 * WHAT RUNS THE FILE. In order: a known interpreter for the extension
 * (`.mjs`/`.js`/`.cjs` → node, `.py` → python), then the file itself when it
 * is executable, then bash. The extension comes FIRST because of Windows,
 * where the executable bit routinely does not survive a copy — without it a
 * JavaScript hook would be handed to bash, which parses it into nonsense and
 * blames the user's syntax.
 */

function hookNameOk(name: string): void {
  if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw HookError.usage(`invalid hook name: '${name}' - use letters, digits, dot, dash or underscore`,
    );
  }
  // The seam is the only door into the hooks directory, so it is also the only place that can
  // stop a caller walking out of it: `../../bin/rm-everything` is refused here
  // rather than trusted anywhere downstream.
  if (name.startsWith('.')) {
    throw HookError.usage(`invalid hook name: '${name}' - a hook name may not start with a dot`);
  }
}

/**
 * The extensions a hook may carry, beyond none at all.
 *
 * A hook is addressed by NAME — `branch-create` — because that name is the
 * contract, and a caller must not have to know what language it was written
 * in. But the file on disk may say: `branch-create.mjs` is how a person writes
 * a JavaScript hook, and on Windows the extension is the only reliable way to
 * know what should run it (the executable bit does not survive a copy).
 *
 * So: the bare name first, then these, in order. First hit wins.
 */
const HOOK_EXTENSIONS = ['.mjs', '.cjs', '.js', '.py', '.sh'] as const;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Where that hook would be if it had no extension. Used in messages. */
export function hookPath(name: string): string {
  hookNameOk(name);
  return join(hooksDir(), name);
}

/** The hook file that exists, extension and all, or `undefined`. */
export function resolveHook(name: string): string | undefined {
  const bare = hookPath(name);
  if (isFile(bare)) return bare;
  for (const ext of HOOK_EXTENSIONS) {
    if (isFile(`${bare}${ext}`)) return `${bare}${ext}`;
  }
  return undefined;
}

export function hookExists(name: string): boolean {
  try {
    return resolveHook(name) !== undefined;
  } catch {
    return false;
  }
}

/**
 * What runs a hook of this name, or `undefined` for "decide by other means".
 *
 * A short, explicit table rather than a shebang parser: the shebang is the
 * right answer on a platform that honours it, and this exists for the platform
 * that does not.
 */
function interpreterFor(path: string): string | undefined {
  if (/\.(mjs|cjs|js)$/i.test(path)) return process.execPath;
  if (/\.py$/i.test(path)) return 'python';
  // `.sh` and no extension at all fall through to the executable bit, then to
  // bash — which is the right answer for both.
  return undefined;
}

/** The last non-empty line, trimmed, with a Windows CR removed. */
function lastAnswer(stdout: string): string {
  let answer = '';
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line !== '') answer = line;
  }
  return answer;
}

/**
 * Run a hook with `context` as JSON on stdin.
 *
 * `undefined` means there is no such hook, which is the ordinary case and not
 * a failure. Anything else either returns the answer or throws.
 */
export function callHook(name: string, context: unknown): string | undefined {
  const path = resolveHook(name);
  if (path === undefined) return undefined;

  // Executable bit: on this checkout core.filemode is false, so a hook copied
  // in by hand on Windows routinely has no executable bit at all. Running it
  // through bash then is not a fallback for a broken hook, it is the normal
  // Windows case — but only for a file bash can actually read, which is why
  // the extension is consulted first.
  let executable = false;
  try {
    executable = process.platform !== 'win32' && (statSync(path).mode & 0o111) !== 0;
  } catch {
    executable = false;
  }

  const interpreter = interpreterFor(path);
  // `bashCommand()` rather than `bash`: on a box with WSL installed a bare
  // `bash` is the WSL launcher, which cannot open a Windows path at all.
  const [command, args] =
    interpreter !== undefined ? [interpreter, [path]] : executable ? [path, []] : [bashCommand(), [path]];

  const r = spawnSync(command, args, {
    input: `${JSON.stringify(context)}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (r.error) {
    throw new HookError('refused', `cannot run the '${name}' hook: ${r.error.message}`, { cause: r.error });
  }
  const said = (r.stderr ?? '').trim();
  const code = r.status ?? 1;
  if (code !== 0) {
    throw new HookError(
      'refused',
      `the '${name}' hook refused (exit ${code})${said === '' ? '' : `:\n${said}`}\nyan will not guess a value it was told not to choose - fix the hook, or the input it was given`,
    );
  }
  // A hook that succeeded may still have said something worth seeing: it is
  // the only channel it has for a warning, and swallowing it now that stderr
  // is captured would be a regression on the inherited behaviour.
  if (said !== '') process.stderr.write(`${said}\n`);

  const answer = lastAnswer(r.stdout ?? '');
  if (answer === '') {
    throw new HookError(
      'silent',
      `the '${name}' hook exited 0 but printed nothing - it must print its answer as one line on stdout`,
    );
  }
  return answer;
}
