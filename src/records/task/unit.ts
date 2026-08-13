import { TaskError } from './errors.js';
import { asString, editUnitIn, readDocument } from './document.js';
import { ENDS, MODES, type HistoryEnd, type HistoryEntry, type ScalarField, type UnitData } from './types.js';

/**
 * One `unit` of a task: one integration branch, one outbound merge request.
 * Holds identity only — every method re-reads the task file.
 */
export class Unit {
  private readonly file: string;
  private readonly taskId: string;

  public readonly name: string;

  /** Use `Task.unit()`, which checks the unit exists; this does not. */
  public constructor(taskFile: string, taskId: string, name: string) {
    this.file = taskFile;
    this.taskId = taskId;
    this.name = name;
  }

  /**
   * This unit as it is on disk right now.
   *
   * @throws TaskError `missing` when the unit is no longer in the document.
   */
  public read(): UnitData {
    const found = readDocument(this.file, this.taskId).units.find((u) => u.name === this.name);
    if (found === undefined) throw new TaskError('missing', `no such unit: ${this.name}`);
    return found;
  }

  /**
   * Overwrite one scalar field, leaving `history[]` alone.
   *
   * @throws TaskError when setting `mode` to something outside MODES.
   */
  public set(field: ScalarField, value: string): void {
    if (field === 'mode' && !(MODES as readonly string[]).includes(value)) {
      throw TaskError.usage(`invalid mode '${value}' - one of: ${MODES.join(' ')}`);
    }
    editUnitIn(this.file, this.taskId, this.name, (unit) => {
      unit[field] = value;
    });
  }

  public setScope(scope: readonly string[]): void {
    editUnitIn(this.file, this.taskId, this.name, (unit) => {
      unit.scope = [...scope];
    });
  }

  public setNeeds(needs: readonly string[]): void {
    editUnitIn(this.file, this.taskId, this.name, (unit) => {
      unit.needs = [...needs];
    });
  }

  /**
   * How many rounds this unit has finished. The round in progress is not
   * counted, so the current one is `rounds() + 1`.
   */
  public rounds(): number {
    return this.read().history.length;
  }

  /**
   * Append one entry to `history[]`, leaving the existing ones untouched.
   *
   * @param at an ISO date, or `''` for today.
   * @throws TaskError when branch, target or end is empty, or `end` is not one
   *   of ENDS.
   */
  public appendHistory(
    branch: string,
    target: string,
    at: string,
    end: string,
    mr?: string | null,
  ): void {
    const entry = historyEntry(branch, target, at, end, mr);
    editUnitIn(this.file, this.taskId, this.name, (unit) => {
      const history = Array.isArray(unit.history) ? unit.history : [];
      unit.history = [...history, entry];
    });
  }

  /**
   * Start a new round: archive the current branch, target and mr into
   * `history[]` under `end`, then move to `newBranch` and clear mr. One write,
   * so a crash leaves either the old round or the new one.
   *
   * @throws TaskError when `newBranch` is empty or `end` is not one of ENDS.
   */
  public rotate(end: string, newBranch: string, at = ''): void {
    if (!newBranch) throw TaskError.usage('rotating a unit needs the new branch name');
    editUnitIn(this.file, this.taskId, this.name, (unit) => {
      const entry = historyEntry(
        asString(unit.branch),
        asString(unit.target),
        at,
        end,
        typeof unit.mr === 'string' ? unit.mr : null,
      );
      const history = Array.isArray(unit.history) ? unit.history : [];
      unit.history = [...history, entry];
      unit.branch = newBranch;
      unit.mr = null;
    });
  }
}

function historyEntry(
  branch: string,
  target: string,
  at: string,
  end: string,
  mr?: string | null,
): HistoryEntry {
  if (!branch || !target || !end) {
    throw TaskError.usage('a history entry needs at least branch, target and end');
  }
  if (!(ENDS as readonly string[]).includes(end)) {
    throw TaskError.usage(`invalid end '${end}' - one of: ${ENDS.join(' ')}`);
  }
  const when = at === '' ? new Date().toISOString().slice(0, 10) : at;
  const entry: HistoryEntry = { branch, target, at: when, end: end as HistoryEnd };
  if (mr !== undefined && mr !== null && mr !== '') entry.mr = mr;
  return entry;
}
