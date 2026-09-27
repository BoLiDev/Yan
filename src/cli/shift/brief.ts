import { join } from 'node:path';
import { readLearnings } from '../../records/memory/index.js';
import { opensMr } from '../../records/shift/index.js';
import type { UnitData } from '../../records/task/index.js';
import { yanHome } from '../../util/home.js';
import { normalizePath } from '../../util/paths.js';
import { vaultDir } from '../../util/vault.js';

/** The learnings index as brief lines, each with a path a shift can open. */
function knownLearnings(): string[] {
  const learnings = readLearnings();
  if (learnings.length === 0) return [];
  return [
    '- What earlier work found out the hard way. When a problem matches one, read it before',
    '  working the problem out again:',
    ...learnings.map((l) => `      ${normalizePath(join(vaultDir(), l.path))} — ${l.name}${l.description === '' ? '' : `: ${l.description}`}`),
  ];
}

export function briefBody(options: {
  sid: string;
  task: string;
  unit: string;
  data: UnitData;
  tree: string;
  clone: string;
  branch: string;
  taskDir: string;
  work: string;
  skills: readonly string[];
  scenario: string;
}): string {
  const { sid, task, unit, data, tree, clone, branch, taskDir, skills } = options;
  const home = yanHome();
  const lines = [
    `# ${sid} ${unit} (task ${task})`,
    '',
    '| | |',
    '| --- | --- |',
    `| unit | ${unit} |`,
    `| repo | ${data.repo} |`,
    `| worktree | ${tree} |`,
    `| shift branch | ${branch} |`,
    `| integration branch | ${data.branch} |`,
    `| scenario | ${options.scenario} |`,
    `| scope | ${data.scope.length > 0 ? data.scope.join(' ') : '(the whole repository)'} |`,
    '',
    ...(skills.length === 0
      ? []
      : [
          '## Skills',
          '',
          `Invoke ${skills.map((s) => `/${s}`).join(', ')} before anything else, and work the way ${skills.length === 1 ? 'it says' : 'they say'}.`,
          'If one is not available, carry on without it and say so in outcome.md.',
          '',
        ]),
    '## The work',
    '',
    options.work,
    '',
    '## What is already known',
    '',
    `- Research, designs and other by-products of this task are in ${taskDir}/artifacts;`,
    '  the work above names the ones that matter here.',
    ...knownLearnings(),
    '',
    '## How this shift works',
    '',
    `- Work only inside ${tree}. Never touch ${clone}: it is the main clone.`,
    `- You are on ${branch}, which was cut from ${data.branch}.${opensMr(options.scenario) ? ` Push it and open a merge request into ${data.branch}.` : ' It stays local: nothing is pushed.'}`,
    `- Run the project's install step first, every time. The tree may be warm from an`,
    '  earlier shift, in which case it finishes in seconds with nothing to do.',
    '- Artifacts go in $YAN_TASK_DIR/artifacts',
    `  (${taskDir}/artifacts), NEVER inside the worktree: the tree is wiped when it is`,
    '  returned, so anything left in it is destroyed or accidentally committed. An',
    '  artifact is a by-product that helps yan and user understand the work - research',
    '  findings, prototypes, designs, screenshots that show the result. The deliverable',
    '  itself is on your branch.',
    '- Throwaway state - build output, a browser profile, a scratch database, logs - is',
    '  not an artifact. Put it in the system temp directory, so it is neither committed',
    '  nor kept.',
    '- Before you report done, write $YAN_SHIFT_DIR/outcome.md',
    `  (${taskDir}/shifts/${sid}/outcome.md): the handover yan reads before it`,
    '  merges your work and decides what comes next. It is for yan, not for the reviewers',
    '  a merge request description is for, so say what the diff cannot:',
    '      Result        what changed, in behaviour, in a few sentences',
    '      Reading       where the brief was ambiguous or silent, and what you chose',
    '      Deviations    where you did not do what the brief said, and why',
    '      Learnings     problems you hit and how you solved them, above all what cost real time',
    '      Left over     what is unfinished, and problems you saw outside scope but did not touch',
    '      Verification  how you checked it, and what you could not check',
    '      Artifacts     what you left in $YAN_TASK_DIR/artifacts',
    '  Leave out a section with nothing in it. Do not restate the brief or walk the diff',
    '  file by file. If yan sends you more work after that, rewrite the file before you',
    '  report done again. `yan report done` refuses until the file exists.',
    '- You have one line to yan:',
    `      ${home}/bin/yan report <done|blocked|needs-decision|conflict> "<line>"`,
    "  The line lands in yan's conversation exactly as you wrote it, so write it the",
    '  way you would tell a colleague: who you are, what happened, where to look.',
    '  `started` is recorded and not sent. Longer than a line goes in outcome.md.',
    '  While user is typing in yan\'s pane the command waits, up to three minutes, and',
    '  then exits 3 with nothing recorded: wait a minute and run the same report again.',
    '  Run it with a timeout of at least four minutes so that wait is not cut short.',
    '- Report only when yan has to act. Progress is not a report; it goes in outcome.md.',
    '- Never end a turn leaving yan something to act on without a report. If you are',
    '  about to end your reply with a question, that question is a `needs-decision`',
    '  report instead. Do not use question dialogs or plan mode: nobody is watching',
    '  your screen, and a dialog is where a shift goes quiet for hours.',
  ];
  if (opensMr(options.scenario)) {
    lines.push(
      '  When you are done, the note must carry the merge request URL, because that',
      '  is how yan learns the address to ask the host about:',
      `      ${home}/bin/yan report done "mr <url>"`,
    );
  }
  lines.push(
    '- yan answers with a line in your conversation, which may name a file; read it',
    '  and carry on. Another round is the same shift, you, so stay until yan clocks',
    '  you out. Reporting done ends a round, not the shift. After done, wait quietly:',
    '  yan may take a while to come back.',
  );
  if (opensMr(options.scenario)) {
    lines.push(
      `  A new round starts from ${data.branch} as it now is: once yan says your last merge`,
      `  request merged, fetch and reset ${branch} onto origin/${data.branch} - what you had`,
      '  is already in it - then work, push, open a new merge request, rewrite outcome.md, and',
      '  report done with the new URL.',
    );
  } else {
    lines.push('  For a new round, do the work, rewrite outcome.md, and report done again.');
  }
  lines.push(
    '- The scope in the table above is where this work belongs. Going outside it is not',
    "  forbidden, but it is not yours to decide quietly: report it, say what you need and",
    '  why, and let yan answer.',
  );
  if (options.scenario === 'explore') {
    lines.push(
      '- This is an explore shift: investigate and write it up. Build it, run it, break it if',
      '  that is what answering the question takes - the tree is thrown away. What you must',
      '  not do is leave anything behind: do not push, do not open a merge request. The',
      '  report goes in $YAN_TASK_DIR/artifacts and outcome.md, and that is the whole deliverable.',
    );
  } else if (options.scenario === 'uix') {
    lines.push(
      '- This is a uix shift: the deliverable is what you put in $YAN_TASK_DIR/artifacts -',
      '  designs, prototypes, visual proposals - and outcome.md describing it. Nothing is',
      '  pushed and no merge request is opened; user looks at the artifacts and accepts',
      '  them or asks for another round.',
    );
  }
  return `${lines.join('\n')}\n`;
}
