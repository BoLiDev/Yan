import { autocomplete, autocompleteMultiselect, confirm, intro, isCancel, note, text } from '@clack/prompts';
import { defaultBranch } from '../util/git.js';
import { detectMonorepo, scopeChoices, unitsForRepo, type Choice, type PlannedUnit, type RegisteredRepo } from './plan.js';
import { YanError } from '../util/error.js';

/**
 * What to prefill the target box with, or `undefined` for any reason it cannot
 * be worked out. Never throws.
 */
function suggestTarget(dir: string): string | undefined {
  try {
    return defaultBranch(dir);
  } catch {
    return undefined;
  }
}

/**
 * Asking a person for a value `argv` did not carry, and nothing else: nothing
 * here writes, opens or merges. Imported dynamically by its callers, so a
 * `yan` that never prompts never loads Clack.
 *
 * Every prompt throws `YanError` `cancelled` when `user` presses escape.
 */

/** What `resolve()` describes a missing option with, restated structurally. */
export interface Missing {
  readonly name: string;
  readonly flag: string;
  readonly describe: string;
}

/** The placeholder every list here carries; all of them are searchable. */
const PLACEHOLDER = 'type to filter';

function cancelled(what: string): YanError {
  return new YanError('ui_cancelled', `cancelled - ${what}`);
}

function answered(value: unknown, what: string): string {
  if (isCancel(value)) throw cancelled(what);
  return String(value ?? '').trim();
}

/**
 * One text prompt per missing option, each refusing an empty answer. Returns
 * them keyed by option name.
 */
export async function askFor(missing: readonly Missing[]): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const option of missing) {
    const value = await text({
      message: `${option.flag}: ${option.describe}`,
      validate: (v) => ((v ?? '').trim() === '' ? 'this one cannot be empty' : undefined),
    });
    answers[option.name] = answered(value, `${option.flag} was not answered`);
  }
  return answers;
}

export interface TaskChoice {
  readonly id: string;
  readonly title: string;
  readonly units: number;
  readonly shifts: number;
}

function taskOption(task: TaskChoice): Choice {
  return {
    value: task.id,
    label: `${task.id}  ${task.title === '' ? '(no title)' : task.title}`,
    hint: task.shifts === 0 ? 'idle' : `${task.shifts} shift(s) live`,
  };
}

/** What `chooseEntry` returns for "create a new task"; the rest are task ids. */
export const CREATE_NEW = '\0create';

export async function chooseEntry(tasks: readonly TaskChoice[], vault: string): Promise<string> {
  // The vault is named in the header: two on one machine is ordinary.
  intro(vault === '' ? 'yan' : `yan · ${vault}`);
  const chosen = await autocomplete({
    message: 'What are we doing?',
    placeholder: PLACEHOLDER,
    options: [
      { value: CREATE_NEW, label: 'create new task' },
      ...tasks.map(taskOption),
    ],
  });
  return answered(chosen, 'nothing was opened');
}

/**
 * `yan done` with no id: a multi-select over the unfinished tasks, since a
 * round that lands usually finishes several. Each row shows how many shifts
 * are live, which is what the command would refuse over.
 */
export async function chooseTasksToFinish(tasks: readonly TaskChoice[]): Promise<string[]> {
  intro('yan done');
  const chosen = await autocompleteMultiselect({
    message: 'Which tasks are finished?',
    placeholder: PLACEHOLDER,
    options: tasks.map(taskOption),
    required: true,
  });
  if (isCancel(chosen)) throw cancelled('nothing was marked done');
  return [...chosen].map((v) => String(v));
}

/**
 * `yan continue` or `yan show` with no id: select among the incomplete tasks.
 * `command` heads the prompt; `message` is the question.
 */
export async function chooseTask(
  tasks: readonly TaskChoice[],
  command: string,
  message: string,
): Promise<string> {
  intro(command);
  const chosen = await autocomplete({
    message,
    placeholder: PLACEHOLDER,
    options: tasks.map(taskOption),
  });
  return answered(chosen, 'nothing was opened');
}

/** `yan abandon` at a terminal: why, in one line. Empty is an answer. */
export async function askAbandonReason(): Promise<string> {
  return answered(
    await text({ message: 'Why is it being given up? (optional)', placeholder: 'leave empty to skip' }),
    'nothing was abandoned',
  );
}

/**
 * `yan abandon` at a terminal: what will happen, then a yes or no that
 * defaults to no. `true` only for an explicit yes.
 */
export async function confirmAbandon(title: string, plan: readonly string[]): Promise<boolean> {
  note(plan.join('\n'), `abandoning ${title}`);
  const yes = await confirm({ message: 'Give this task up?', initialValue: false });
  if (isCancel(yes)) throw cancelled('nothing was abandoned');
  return yes;
}

/** One draft as `yan draft ls` offers it; `updated` is already formatted. */
export interface DraftChoice {
  readonly id: string;
  readonly updated: string;
  readonly title: string;
  readonly preview: string;
}

/** `yan draft ls` on a terminal: which draft to open. Returns its id. */
export async function chooseDraft(drafts: readonly DraftChoice[], task: string): Promise<string> {
  intro(`yan draft · ${task}`);
  const chosen = await autocomplete({
    message: 'Which draft do you want to open?',
    placeholder: PLACEHOLDER,
    options: drafts.map((d) => ({
      value: d.id,
      label: `${d.updated}  ${d.title}${d.preview === '' ? '' : `  ${d.preview}`}`,
    })),
  });
  return answered(chosen, 'no draft was opened');
}

/** One row of `yan repo add`'s scan, as the command layer worked it out. */
export interface RepoCandidate {
  readonly name: string;
  readonly dir: string;
  readonly url: string;
  /** Why it cannot be selected, or the empty string when it can. */
  readonly blocked: string;
}

/**
 * `yan repo add` with no argument: which of the scanned directories to
 * register. A blocked candidate is listed with its reason and dropped from
 * the result even if it is picked.
 */
export async function chooseReposToAdd(
  dir: string,
  candidates: readonly RepoCandidate[],
): Promise<string[]> {
  intro(`yan repo add — ${dir}`);
  const selectable = candidates.filter((c) => c.blocked === '');
  if (selectable.length === 0) {
    note(
      candidates.map((c) => `${c.name}  —  ${c.blocked}`).join('\n'),
      'nothing here can be added',
    );
    return [];
  }

  const chosen = await autocompleteMultiselect({
    message: 'Which of these does this context work in?',
    placeholder: PLACEHOLDER,
    options: candidates.map((c) => ({
      value: c.name,
      label: c.blocked === '' ? c.name : `${c.name}  (${c.blocked})`,
      hint: c.url === '' ? c.dir : c.url,
    })),
    required: false,
  });
  if (isCancel(chosen)) throw cancelled('nothing was registered');

  const blocked = new Set(candidates.filter((c) => c.blocked !== '').map((c) => c.name));
  return [...chosen].map((v) => String(v)).filter((name) => !blocked.has(name));
}

/** One row of `yan repo rm`'s list, as the command layer worked it out. */
export interface RepoRemovable {
  readonly name: string;
  readonly url: string;
  /** Where it is on this machine, or the empty string when it is not linked here. */
  readonly path: string;
  /** Why it cannot be selected, or the empty string when it can. */
  readonly blocked: string;
}

/**
 * `yan repo rm` with no argument: which registered repositories to take out.
 * A blocked one is listed with its reason and dropped from the result even if
 * it is picked.
 */
export async function chooseReposToRemove(candidates: readonly RepoRemovable[]): Promise<string[]> {
  intro('yan repo rm');
  const selectable = candidates.filter((c) => c.blocked === '');
  if (selectable.length === 0) {
    note(
      candidates.map((c) => `${c.name}  —  ${c.blocked}`).join('\n'),
      'nothing here can be removed',
    );
    return [];
  }

  const chosen = await autocompleteMultiselect({
    message: 'Which of these should this context forget? Clones on disk are left alone.',
    placeholder: PLACEHOLDER,
    options: candidates.map((c) => ({
      value: c.name,
      label: c.blocked === '' ? c.name : `${c.name}  (${c.blocked})`,
      hint: c.path === '' ? `${c.url}  not linked here` : c.path,
    })),
    required: false,
  });
  if (isCancel(chosen)) throw cancelled('nothing was removed');

  const blocked = new Set(candidates.filter((c) => c.blocked !== '').map((c) => c.name));
  return [...chosen].map((v) => String(v)).filter((name) => !blocked.has(name));
}

export interface TaskNewAnswers {
  readonly title: string;
  readonly description: string;
  readonly units: readonly PlannedUnit[];
}

/**
 * `yan task new`'s wizard: title, description, repositories, per-repo scope,
 * then target. The target box is prefilled with the remote's default branch
 * where there is one, and is empty otherwise — never answered unseen.
 */
export async function askTaskNew(
  repos: readonly RegisteredRepo[],
  given: { title?: string; description?: string },
): Promise<TaskNewAnswers> {
  intro('yan task new');

  const title =
    given.title !== undefined && given.title !== ''
      ? given.title
      : answered(
          await text({ message: 'What is this task called?', validate: (v) => ((v ?? '').trim() === '' ? 'a task needs a title' : undefined) }),
          'no task was created',
        );

  const description =
    given.description !== undefined
      ? given.description
      : answered(
          await text({ message: 'Describe it (optional)', placeholder: 'leave empty to skip' }),
          'no task was created',
        );

  if (repos.length === 0) {
    throw new YanError('ui_blocked', 'no repositories are registered - run `yan repo add` where your clones live, then create the task');
  }

  const chosen = await autocompleteMultiselect({
    message: 'Which repositories does this task involve?',
    placeholder: PLACEHOLDER,
    options: repos.map((r) => ({ value: r.name, label: r.name, hint: r.url })),
    required: true,
  });
  if (isCancel(chosen)) throw cancelled('no task was created');

  const units: PlannedUnit[] = [];
  const used = new Set<string>();
  for (const name of chosen) {
    const repo = repos.find((r) => r.name === name);
    if (repo === undefined) continue;

    const detection = detectMonorepo(repo.dir);
    let scopes: string[] = [];
    if (detection.monorepo) {
      const picked = await autocompleteMultiselect({
        message: `${name}: which packages are in scope?`,
        placeholder: PLACEHOLDER,
        options: scopeChoices(detection),
        required: true,
      });
      if (isCancel(picked)) throw cancelled('no task was created');
      scopes = [...picked];
    }

    const suggested = suggestTarget(repo.dir);
    const target = answered(
      await text({
        message: `${name}: which branch does this deliver into?`,
        ...(suggested === undefined ? {} : { initialValue: suggested }),
        validate: (v) => ((v ?? '').trim() === '' ? 'yan never guesses a target: say which branch this unit delivers into' : undefined),
      }),
      'no task was created',
    );

    units.push(...unitsForRepo({ repo: name, scopes, target }, used));
  }

  note(
    units
      .map((u) => `${u.unit} (${u.repo}${u.scope.length > 0 ? `/${u.scope[0] as string}` : ''} → ${u.target})`)
      .join('\n'),
    `${units.length} unit(s)`,
  );

  return { title, description, units };
}
