import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { out } from '../shared/action.js';
import { readScenarios, resolveShift, runsAs } from '../shared/agents.js';
import { deliverableLines, deliverableTally, NO_DELIVERABLES_NOTICE } from '../shared/deliverables.js';
import { terminalWidth } from '../shared/style.js';
import { Deliverables, Task, readDeliverables } from '../../records/task/index.js';
import { Log, type LogType } from '../../records/log/index.js';
import { readLearnings, readSkills, type Indexed } from '../../records/memory/index.js';
import { Drafts } from '../../records/drafts/index.js';
import { memDir, vaultDir } from '../../util/vault.js';
import { normalizePath } from '../../util/paths.js';
import { localStamp } from '../../util/time.js';
import { isYanError } from '../../util/error.js';

/**
 * The briefing half of `yan session-start`: what the main agent reads after
 * the picture — the task's memory, the scenarios a shift can be dispatched
 * as, and the skills. Most of it is prompt, the words the main agent starts
 * its session with, so change it here without reading the pool or the forge.
 */

/** How many of the most recent log entries a session starts with. */
export const LOG_TAIL = 20;

/** How many of the newest drafts a session starts with. */
export const DRAFTS_SHOWN = 10;

/** The log entries a session starts with in full, however old. */
const LOG_KEPT: readonly LogType[] = ['agreed', 'changed'];

function readTrimmed(file: string): string {
  try {
    return readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  } catch {
    return '';
  }
}

/**
 * `user`'s drafts: how many, and the newest by id, date and title. Their text
 * stays out, since a draft is read when it looks relevant rather than every
 * session.
 */
function renderDrafts(id: string): void {
  const drafts = new Drafts(id);
  const total = drafts.count();
  out('');
  if (total === 0) {
    out("── drafts  none yet (user writes them with 'yan draft')");
    return;
  }
  const shown = drafts.list({ limit: DRAFTS_SHOWN });
  out(`── drafts  ${shown.length < total ? `${shown.length} of ${total}` : `${total}`}  ${drafts.dir}`);
  out("user's own notes about this task, written outside this conversation. Read one");
  out("with 'yan draft cat <id>' when it looks relevant; yan never writes them.");
  out(`Past the newest ${DRAFTS_SHOWN}: 'yan draft ls --plain --limit <n>' lists more and 'yan draft`);
  out("search <words>' finds a phrase. Other tasks' drafts are plain markdown under");
  out(`${normalizePath(vaultDir())}/tasks/<id>/artifacts/drafts/ - grep there when an earlier task's note might apply.`);
  out('');
  for (const d of shown) out(`  ${d.id}  ${localStamp(new Date(d.updated))}  ${d.title}`);
}

/**
 * What the task has to build, and the notice that comes instead when nobody
 * has said yet. A file that does not validate is reported here and stops
 * nothing: the rest of the picture is still worth having.
 */
function renderDeliverables(id: string, complete: boolean): void {
  const record = new Deliverables(id);
  const { deliverables, problem } = readDeliverables(id);

  out('');
  if (problem !== null) {
    out('── deliverables  UNREADABLE');
    out(problem);
    out("Nothing was changed. Fix the file by hand, or 'yan deliverable' will refuse too.");
    return;
  }
  if (deliverables.length === 0) {
    if (complete) {
      out(`── deliverables  none recorded  ${record.file}`);
      return;
    }
    out(`── deliverables  none yet  ${record.file}`);
    for (const line of NO_DELIVERABLES_NOTICE) out(line);
    return;
  }
  out(`── deliverables  ${deliverableTally(deliverables)}  ${record.file}`);
  out('What this task has to build to solve the problems the brief states. Written');
  out("only by 'yan deliverable'; log.md says how they moved, this says what they are.");
  out('');
  for (const line of deliverableLines(deliverables, {}, terminalWidth())) out(line);
}

/**
 * What the task has remembered: its brief, what it has to build, the log
 * entries that still bind, the learnings index and `mem/user.md`. Printed
 * for one task only.
 */
function renderMemory(id: string, complete: boolean): void {
  const record = new Task(id);

  out('');
  out(`── brief  ${normalizePath(join(record.dir, 'brief.md'))}`);
  out('The background and the problems this task is there to solve.');
  out('');
  out(readTrimmed(join(record.dir, 'brief.md')) || '(empty)');

  renderDeliverables(id, complete);
  renderDrafts(id);

  const taskLog = new Log(id);
  const log = taskLog.excerpt(LOG_KEPT, LOG_TAIL);
  out('');
  out(`── log  ${log.lines.length < log.total ? `${log.lines.length} of ${log.total} entries` : `${log.total} entries`}  ${taskLog.file}`);
  out(`Every agreed and changed entry, and the last ${LOG_TAIL} of any kind. An agreed`);
  out('entry is what was understood then, not a verdict for ever: a later one');
  out('overrides it, and an option dropped before can be raised again if you say it');
  out('was dropped before, and why.');
  out('');
  for (const line of log.lines.length > 0 ? log.lines : ['(nothing logged yet)']) out(line);

  const learnings = readLearnings();
  if (learnings.length > 0) {
    out('');
    out('── learnings');
    out('What earlier work found out the hard way. Open the one that matches before');
    out('working a problem out again.');
    out('');
    for (const l of learnings) {
      out(`  ${l.path}`);
      out(`      ${l.name}${l.description === '' ? '' : ` — ${l.description}`}`);
    }
  }

  let user = '';
  try {
    user = readTrimmed(join(memDir(), 'user.md'));
  } catch {
    user = '';
  }
  if (user !== '') {
    out('');
    out('── user  mem/user.md');
    out('');
    out(user);
  }
}

/**
 * Everything after the picture: the task's memory when the session is about
 * one task, then the scenarios and the skills.
 */
export function renderBriefing(memoryOf: string | undefined, complete: boolean): void {
  if (memoryOf !== undefined) renderMemory(memoryOf, complete);
  renderScenarios();
  renderSkills(readSkills());
}

/**
 * What a shift can be dispatched as: each scenario, its tiers, and what each
 * tier really runs. Problems in the configuration are printed rather than
 * hidden, because a dispatch will refuse over them.
 */
function renderScenarios(): void {
  const { scenarios, problems } = readScenarios();
  out('');
  out('── scenarios');
  out('What a shift can be dispatched as: yan shift new --scenario <s> [--tier <t>].');
  out("Choose the scenario by the kind of work and the tier by its description; the");
  out("scenario's default when unsure. Only these exist - there is no other model to ask for.");
  out('');
  for (const scenario of scenarios) {
    out(`  ${scenario.name} — ${scenario.description}`);
    for (const tier of scenario.tiers) {
      const mark = tier.name === scenario.defaultTier ? ' (default)' : '';
      let runs: string;
      try {
        runs = runsAs(resolveShift('session_start', scenario.name, tier.name));
      } catch (err) {
        // A tier with no cli over an unset agents.shift: one line, not a
        // session start that never finishes the picture.
        out(`      ${tier.name}${mark}  WARN ${isYanError(err) ? err.message : String(err)}`);
        continue;
      }
      out(`      ${tier.name}${mark}  ${runs}${tier.description === '' ? '' : ` — ${tier.description}`}`);
    }
  }
  for (const problem of problems) out(`  WARN ${problem}`);
}

/** Print the skills index: a path, a name and a sentence each. Silent when empty. */
function renderSkills(skills: readonly Indexed[]): void {
  if (skills.length === 0) return;
  out('');
  out('What you may do yourself here.');
  out('');
  out('Standing instructions from `user` about this environment. Where one covers');
  out('what is being asked, read it and do the thing yourself rather than');
  out('dispatching a shift, and say which one you acted on.');
  out('');
  for (const skill of skills) {
    out(`  ${skill.path}`);
    out(`      ${skill.name}${skill.description === '' ? '' : ` — ${skill.description}`}`);
  }
}
