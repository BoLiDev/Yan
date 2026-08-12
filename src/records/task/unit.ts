import { TaskError } from './errors.js';
import { asString, editUnitIn, readDocument } from './document.js';
import { ENDS, MODES, type HistoryEnd, type HistoryEntry, type ScalarField, type UnitData } from './types.js';

/**
 * One `unit` of a task: one delivery channel, one integration branch, one
 * outbound merge request.
 *
 * Its state is identity, not data — the task's file and this unit's name. Every
 * method re-reads, because another process may have written in between and a
 * cached document would be a lie with a long half-life.
 */
export class Unit {
  private readonly file: string;
  private readonly taskId: string;

  public readonly name: string;

  /** Built by `Task.unit()`; there is no reason to construct one by hand. */
  public constructor(taskFile: string, taskId: string, name: string) {
    this.file = taskFile;
    this.taskId = taskId;
    this.name = name;
  }

  /** This unit as it is on disk right now. */
  public read(): UnitData {
    const found = readDocument(this.file, this.taskId).units.find((u) => u.name === this.name);
    if (found === undefined) throw new TaskError('missing', `no such unit: ${this.name}`);
    return found;
  }

  /** The only writer of the four current scalars. It never touches history[]. */
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
   * How many rounds this unit has delivered or abandoned.
   *
   * The generated integration branch name carries r<n>, where n is
   * length(history) + 1 — so the round number is derived and never stored, and
   * cannot disagree with the history it is counting.
   */
  public rounds(): number {
    return this.read().history.length;
  }

  /**
   * The only history writer in the code base.
   *
   * It builds `history + [entry]`, so every existing entry is carried across
   * untouched by construction — there is no index parameter anywhere in this
   * class, which is how "history[] is append-only" is enforced rather than
   * merely intended. Pass an empty string for `at` to mean today.
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
   * Start a new round: archive the current branch/target/mr into history[],
   * then overwrite the branch and clear mr — in one tmp → mv, because a crash
   * between the archive and the overwrite would lose the round it was in.
   *
   * Deciding `end` is the caller's business, not this record's.
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
  // `mr` only when there is one: an abandoned round may never have opened one.
  if (mr !== undefined && mr !== null && mr !== '') entry.mr = mr;
  return entry;
}
