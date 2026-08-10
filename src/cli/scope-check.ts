import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { CommandError } from './support/errors.js';
import { diffNameOnly, git, gitOk, statusPorcelain } from '../util/git.js';
import { findUnit, readTask, taskExists } from '../store/task.js';
import { shiftMetaTree, shiftMetaUnit, shiftResolve } from '../store/shift.js';
import { action, out } from './support/action.js';

/**
 * `yan scope-check <sid>` — which changed paths lie outside the unit's scope.
 *
 * ---------------------------------------------------------------------------
 * IT REPORTS. IT NEVER BLOCKS.
 * ---------------------------------------------------------------------------
 *
 * delivery.md §8.3 is explicit, and the reason is worth keeping in front of
 * whoever edits this next:
 *
 *   > While changing `apps/auth` you discover you have to touch a type in
 *   > `apps/common`. This happens constantly in real work. Refusing outright
 *   > would leave the agent stuck, or quietly working around the check.
 *
 * So finding out-of-scope paths is a SUCCESSFUL run of this command: it exits 0
 * and says what to do about it. A non-zero exit means something really went
 * wrong (no such shift, git could not be asked), never that the diff was
 * inconvenient.
 *
 * What counts as changed: everything the shift has done to the tree it leased —
 * commits since the integration branch, staged and unstaged edits, and files it
 * has created but not yet added. An untracked file in the wrong package is
 * exactly the kind of stray edit this is meant to surface, and `git diff` alone
 * would never see it.
 */

function untrackedFiles(tree: string): string[] {
  const porcelain = statusPorcelain(tree, ['--untracked-files=all']);
  return porcelain
    .split(/\r?\n/)
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3));
}

function inScope(path: string, scope: readonly string[]): boolean {
  for (const s of scope) {
    if (s === '' || s === '.') return true;
    if (path === s) return true;
    if (path.startsWith(`${s}/`)) return true;
  }
  return false;
}

export const command = new Command('scope-check')
  .description('report paths a shift changed that lie outside its unit scope')
  .argument('[sid]')
  .option('--task <id>', 'the task the shift belongs to')
  .option('--json', 'machine readable output')
  .action(
    action('scope-check', (sid: string | undefined, options: { task?: string; json?: boolean }) => {
      if (sid === undefined || sid === '') {
        throw new CommandError('scope', 'usage', 'a shift id is required', { exitCode: 2 });
      }
      const ref = shiftResolve(sid, options.task ?? '');
      const unit = shiftMetaUnit(ref) ?? '';
      const tree = shiftMetaTree(ref);

      if (tree === undefined) {
        throw new CommandError('scope', 'no_tree', `run/meta.json for ${sid} records no tree - there is no working tree to diff`,
        );
      }
      if (!existsSync(tree)) {
        throw new CommandError('scope', 'no_tree', `the tree recorded for ${sid} is not there: ${tree}`);
      }

      // `scope` belongs to the unit in task.json, so a shift whose meta names no
      // unit (or a task that has no such unit) has nothing to check against.
      // That is reported plainly rather than treated as "everything is out of
      // scope".
      let scopeKnown = false;
      let scope: string[] = [];
      let base = '';
      if (ref.task !== '' && unit !== '' && taskExists(ref.task)) {
        const found = findUnit(readTask(ref.task), unit);
        if (found !== undefined) {
          scopeKnown = true;
          scope = found.scope.map((p) => p.replace(/\/+$/, ''));
          base = found.branch;
        }
      }

      let baseRef = '';
      let baseWhy = '';
      if (base !== '') {
        if (gitOk(tree, ['show-ref', '--verify', '--quiet', `refs/heads/${base}`])) {
          baseRef = base;
        } else if (
          gitOk(tree, ['rev-parse', '--verify', '--quiet', `origin/${base}^{commit}`])
        ) {
          baseRef = `origin/${base}`;
        } else {
          baseWhy = `the integration branch '${base}' is not in this tree, so only the working tree was compared`;
        }
      } else {
        baseWhy = 'no integration branch recorded, so only the working tree was compared';
      }

      const changed = new Set<string>();
      if (baseRef !== '') {
        // Three dots: what this branch changed since it left the integration
        // branch, not everything that has happened on the other side of it.
        const r = git(tree, ['diff', '--name-only', `${baseRef}...HEAD`]);
        if (r.code === 0) {
          for (const p of r.stdout.split(/\r?\n/)) if (p !== '') changed.add(p);
        }
      }
      for (const p of diffNameOnly(tree, ['HEAD'])) changed.add(p);
      for (const p of untrackedFiles(tree)) changed.add(p);

      const all = [...changed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const inside: string[] = [];
      const outside: string[] = [];
      for (const p of all) {
        if (!scopeKnown || scope.length === 0 || inScope(p, scope)) inside.push(p);
        else outside.push(p);
      }

      if (options.json === true) {
        out(
          JSON.stringify({
            version: 1,
            sid: ref.sid,
            task: ref.task,
            unit,
            tree,
            base: baseRef !== '' ? baseRef : base,
            scope_known: scopeKnown,
            scope,
            in_scope: inside,
            out_of_scope: outside,
            blocked: false,
          }),
        );
        return;
      }

      out(`${ref.sid}  task ${ref.task === '' ? '-' : ref.task}  unit ${unit === '' ? '-' : unit}`);
      out(`tree     ${tree}`);
      if (!scopeKnown) {
        out('scope    (unknown: no unit recorded for this shift, or no such unit in task.json)');
      } else if (scope.length === 0) {
        out(`scope    (empty: unit ${unit} restricts nothing, so nothing can be outside it)`);
      } else {
        out(`scope    ${scope.join(' ')}`);
      }
      out(`base     ${baseWhy !== '' ? baseWhy : baseRef}`);
      out(
        `changed  ${inside.length + outside.length} file(s): ${inside.length} in scope, ${outside.length} outside`,
      );

      if (outside.length > 0) {
        out('');
        out('out of scope');
        for (const p of outside) out(`  ${p}`);
        out('');
        out('This is a report, not a refusal. If the work belongs here, widen the');
        out("unit's scope in task.json and add a line to log.md (delivery.md §8.3).");
      }
      // Always 0 when the check ran. Reporting is the whole job.
    }),
  );
