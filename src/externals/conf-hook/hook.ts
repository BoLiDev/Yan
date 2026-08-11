import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { yanHome } from '../../util/home.js';
import { HookError } from './errors.js';

/**
 * The calling protocol for `conf/hooks/` — the TypeScript half of
 * `bin/lib-hook.sh` (boundaries.md §10, architecture.md §4.3).
 *
 * THIS IS THE ONLY PLACE ALLOWED TO EXECUTE ANYTHING UNDER conf/. That is the
 * whole reason it is a module of its own: `conf/` holds `user`'s local choices,
 * it is gitignored, it is not part of yan, and there has to be exactly one door
 * through which yan asks it a question.
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
 * The hook's stderr is deliberately NOT captured: whatever it wants to say
 * about a refusal should reach `user` unedited.
 */

function hookNameOk(name: string): void {
  if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw HookError.usage(`invalid hook name: '${name}' - use letters, digits, dot, dash or underscore`,
    );
  }
  // The seam is the only door into conf/, so it is also the only place that can
  // stop a caller walking out of it: `../../bin/rm-everything` is refused here
  // rather than trusted anywhere downstream.
  if (name.startsWith('.')) {
    throw HookError.usage(`invalid hook name: '${name}' - a hook name may not start with a dot`);
  }
}

/** Where that hook would be, whether or not the file exists. */
export function hookPath(name: string): string {
  hookNameOk(name);
  return join(yanHome(), 'conf', 'hooks', name);
}

export function hookExists(name: string): boolean {
  let path: string;
  try {
    path = hookPath(name);
  } catch {
    return false;
  }
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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
  const path = hookPath(name);
  if (!existsSync(path)) return undefined;

  // Executable bit: on this checkout core.filemode is false and conf/ is
  // gitignored, so a hook copied in by hand on Windows routinely has no
  // executable bit at all. Running it through bash then is not a fallback for
  // a broken hook, it is the normal Windows case — and a hook that IS
  // executable is still run directly, so a Python or Node hook works.
  let executable = false;
  try {
    executable = process.platform !== 'win32' && (statSync(path).mode & 0o111) !== 0;
  } catch {
    executable = false;
  }

  const r = executable
    ? spawnSync(path, [], { input: `${JSON.stringify(context)}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    : spawnSync('bash', [path], { input: `${JSON.stringify(context)}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

  if (r.error) {
    throw new HookError('refused', `cannot run the '${name}' hook: ${r.error.message}`, { cause: r.error });
  }
  const code = r.status ?? 1;
  if (code !== 0) {
    throw new HookError(
      'refused',
      `the '${name}' hook refused (exit ${code}) - stop and fix the hook, or the input it was given; yan will not guess a value it was told not to choose`,
    );
  }

  const answer = lastAnswer(r.stdout ?? '');
  if (answer === '') {
    throw new HookError(
      'silent',
      `the '${name}' hook exited 0 but printed nothing - it must print its answer as one line on stdout`,
    );
  }
  return answer;
}
