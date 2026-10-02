import { autocomplete, autocompleteMultiselect, confirm, intro, isCancel, text } from '@clack/prompts';
import { YanError } from '../util/error.js';

/**
 * Asking a person for a value `argv` did not carry, and nothing else: nothing
 * here writes, opens or launches. Imported dynamically by its callers, so a
 * command that never prompts never loads Clack.
 *
 * Every prompt throws `YanError` `ui_cancelled` when `user` presses escape.
 */

/** The placeholder every list here carries; all of them are searchable. */
const PLACEHOLDER = 'type to filter';

function cancelled(what: string): YanError {
  return new YanError('ui_cancelled', `cancelled - ${what}`);
}

function answered(value: unknown, what: string): string {
  if (isCancel(value)) throw cancelled(what);
  return String(value ?? '').trim();
}

/** A text prompt that refuses an empty answer. */
async function required(message: string, what: string): Promise<string> {
  const value = await text({
    message,
    validate: (v) => ((v ?? '').trim() === '' ? 'this one cannot be empty' : undefined),
  });
  return answered(value, what);
}

/** `yan vault init`: asks for whichever of the name and the remote `argv` left empty. */
export async function askVaultInit(given: { name: string; remote: string }): Promise<{ name: string; remote: string }> {
  intro('yan vault init');
  const name = given.name !== ''
    ? given.name
    : await required('A short name for this context, e.g. personal', 'no vault name was given');
  const remote = given.remote !== ''
    ? given.remote
    : await required('The empty repository to push this vault to', 'no remote was given');
  return { name, remote };
}

/** `yan vault clone` with no url. */
export async function askVaultClone(): Promise<string> {
  intro('yan vault clone');
  return required('The vault repository to clone', 'no url was given');
}

export interface TaskChoice {
  readonly id: string;
  readonly title: string;
}

function taskOption(task: TaskChoice): { value: string; label: string } {
  return { value: task.id, label: `${task.id}  ${task.title === '' ? '(no title)' : task.title}` };
}

/** What `chooseEntry` returns for "a new task"; the rest are task ids. */
export const CREATE_NEW = '\u0000new';

/** Bare `yan`: an open task to work on, or a new one. */
export async function chooseEntry(tasks: readonly TaskChoice[], vault: string): Promise<string> {
  // The vault is named in the header: two on one machine is ordinary.
  intro(vault === '' ? 'yan' : `yan · ${vault}`);
  const chosen = await autocomplete({
    message: 'What are we working on?',
    placeholder: PLACEHOLDER,
    options: [{ value: CREATE_NEW, label: 'new task' }, ...tasks.map(taskOption)],
  });
  return answered(chosen, 'nothing was started');
}

/** A new task's title. */
export async function askTitle(): Promise<string> {
  return required('What is this task called?', 'no task was created');
}

/** Whether to lease a tree of the repository `yan` was typed in. Defaults to yes. */
export async function confirmTree(repo: string, why = ''): Promise<boolean> {
  const message = [why, `Open a worktree of ${repo}?`].filter((s) => s !== '').join(' ');
  const yes = await confirm({ message, initialValue: true });
  if (isCancel(yes)) throw cancelled('nothing was started');
  return yes;
}

/** The choice standing for the whole repository. */
const WHOLE_REPO = '\u0000whole';

/**
 * A new task's scope: which of `repo`'s packages it is about. `[]` for the
 * whole repository, which drops any package picked beside it.
 */
export async function chooseScope(repo: string, packages: readonly string[]): Promise<string[]> {
  const chosen = await autocompleteMultiselect({
    message: `${repo}: which packages are in scope?`,
    placeholder: PLACEHOLDER,
    options: [
      ...packages.map((p) => ({ value: p, label: p })),
      { value: WHOLE_REPO, label: 'the whole repository', hint: 'no scope restriction' },
    ],
    required: true,
  });
  if (isCancel(chosen)) throw cancelled('no task was created');
  const picked = [...chosen].map((v) => String(v));
  return picked.includes(WHOLE_REPO) ? [] : picked;
}

/** Select one open task. `command` heads the prompt; `message` is the question. */
export async function chooseTask(tasks: readonly TaskChoice[], command: string, message: string): Promise<string> {
  intro(command);
  const chosen = await autocomplete({ message, placeholder: PLACEHOLDER, options: tasks.map(taskOption) });
  return answered(chosen, 'nothing was chosen');
}

/** `yan done` with no id: several at once, since one round usually finishes more than one. */
export async function chooseTasksToFinish(tasks: readonly TaskChoice[]): Promise<string[]> {
  intro('yan done');
  const chosen = await autocompleteMultiselect({
    message: 'Which tasks are finished?',
    placeholder: PLACEHOLDER,
    options: tasks.map(taskOption),
    required: true,
  });
  if (isCancel(chosen)) throw cancelled('nothing was closed');
  return [...chosen].map((v) => String(v));
}

/** One draft as `yan draft ls` offers it; `updated` is already formatted. */
interface DraftChoice {
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
