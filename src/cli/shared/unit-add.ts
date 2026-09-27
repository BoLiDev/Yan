import { readNote, appendLog } from './note.js';
import { repoDir } from './repo.js';
import { insideTask, existingTask } from './task-id.js';
import { checkRefName, decideBranchName, ensureBranch, freshenClone, type NameSource } from './branch.js';
import { YanError } from '../../util/error.js';

export interface AddOptions {
  task?: string;
  unit?: string;
  repo?: string;
  target?: string;
  branch?: string;
  base?: string;
  scope: string[];
  needs: string[];
  note?: string;
  json?: boolean;
  /** The caller has already fetched this unit's clone, so this must not. */
  fetched?: boolean;
}

export interface AddResult {
  readonly task: string;
  readonly unit: string;
  readonly branch: string;
  readonly target: string;
  readonly name_from: NameSource;
  readonly branch_state: string;
}

/**
 * `yan unit add` without the process around it: name the branch, make it
 * exist, record the unit, append the log line. `yan task new` calls it for
 * each unit it is given, which is why it lives here and not in `unit.ts`.
 *
 * @throws YanError `unit_add_usage` for a missing argument or unknown task,
 *   `exists` when the unit is already there, `not_recorded` when the branch
 *   was made but task.json could not be written.
 */
export function addTaskUnit(options: AddOptions): AddResult {
  const task = options.task ?? insideTask('unit_add');
  const unit = options.unit ?? '';
  const repo = options.repo ?? '';
  const target = options.target ?? '';

  if (unit === '') throw YanError.usage('unit_add_usage', '--unit is required');
  if (repo === '') {
    throw YanError.usage('unit_add_usage', '--repo is required: a repository under repos/, or the path to a clone');
  }
  const note = readNote('unit_add', options.note);
  if (target === '') {
    throw YanError.usage('unit_add_usage', '--target is required and is never guessed: say which branch this unit delivers into. A release period and a quiet period have different answers, so there is no safe default',
    );
  }

  const record = existingTask('unit_add', task);
  if (record.findUnit(unit) !== undefined) {
    throw new YanError('unit_add_exists', `unit already exists: ${unit} - 'yan unit set' changes one, 'yan show ${task}' shows them`,
    );
  }

  const clone = repoDir('unit_add', repo);

  // A unit being added has no history, so its round is always the first.
  const round = 1;
  const { branch, from, raw } = decideBranchName(options.branch, { task, unit, round });
  checkRefName('unit_add', branch, raw);

  if (options.fetched !== true) freshenClone('yan unit add', clone, repo);
  const how = ensureBranch('yan unit add', clone, branch, options.base ?? target);

  try {
    record.addUnit(unit, repo, target, {
      branch,
      scope: options.scope,
      needs: options.needs,
    });
  } catch (err) {
    throw new YanError('unit_add_not_recorded', `the branch '${branch}' is ready in ${clone}, but task.json was not updated: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  appendLog('yan unit add', task, 'started', `${unit}  unit added on ${branch} → ${target} (${how}; name from ${from})`, note);

  return { task, unit, branch, target, name_from: from, branch_state: how };
}
