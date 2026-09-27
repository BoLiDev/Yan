import { join } from 'node:path';
import type { ShiftSpec } from '../shared/agents.js';
import { readLearnings } from '../../records/memory/index.js';
import type { UnitData } from '../../records/task/index.js';
import { yanHome } from '../../util/home.js';
import { normalizePath } from '../../util/paths.js';
import { vaultDir } from '../../util/vault.js';

type Scenario = ShiftSpec['scenario'];

/** Where the lines of one scenario's work order are filled in from. */
interface Places {
  /** The shift branch. */
  readonly branch: string;
  /** The integration branch it was cut from. */
  readonly base: string;
  readonly home: string;
}

/**
 * Everything the work order says differently by scenario, and nothing else:
 * the paragraphs around these lines are the same for every shift. Each entry
 * is whole lines, already wrapped and indented to sit where it goes.
 *
 * A shift reads the work order once and then works alone, so a sentence that
 * is true of one scenario and sent to another is an instruction it will try
 * to follow: an explore shift told its deliverable is on its branch, or asked
 * about a diff it does not have.
 */
interface WorkOrder {
  /** The end of the line naming the branch: what happens to it. */
  readonly branchLine: (p: Places) => string;
  /** After what an artifact is: where the deliverable itself is. */
  readonly deliverableLine: readonly string[];
  /** What outcome.md is read before, and what it should say that nothing else does. */
  readonly handover: readonly string[];
  /** The Result section of outcome.md. */
  readonly result: string;
  /** What outcome.md is not for, besides restating the brief: one line. */
  readonly notInOutcome: string;
  /** What the done report must carry, after the report command. */
  readonly doneLine: (p: Places) => readonly string[];
  /** How the next round starts. */
  readonly nextRound: (p: Places) => readonly string[];
  /** The last paragraph: what kind of shift this is, when it is not coding. */
  readonly closing: readonly string[];
}

const WORK_ORDERS: Record<Scenario, WorkOrder> = {
  coding: {
    branchLine: (p) => ` Push it and open a merge request into ${p.base}.`,
    deliverableLine: ['  The deliverable itself is on your branch.'],
    handover: [
      '  merges your work and decides what comes next. It is for yan, not for the reviewers',
      '  a merge request description is for, so say what the diff cannot:',
    ],
    result: 'what changed, in behaviour, in a few sentences',
    notInOutcome: '  walk the diff file by file.',
    doneLine: (p) => [
      '  When you are done, the note must carry the merge request URL, because that',
      '  is how yan learns the address to ask the host about:',
      `      ${p.home}/bin/yan report done "mr <url>"`,
    ],
    nextRound: (p) => [
      `  A new round starts from ${p.base} as it now is: once yan says your last merge`,
      `  request merged, fetch and reset ${p.branch} onto origin/${p.base} - what you had`,
      '  is already in it - then work, push, open a new merge request, rewrite outcome.md, and',
      '  report done with the new URL.',
    ],
    closing: [],
  },
  explore: {
    branchLine: () => ' It stays local: do not push it, and open no merge request.',
    deliverableLine: [
      '  Here the report is the deliverable: it goes in $YAN_TASK_DIR/artifacts too.',
    ],
    handover: [
      '  accepts your report and decides what comes next. The report says what you found;',
      '  this says what yan needs to judge it by:',
    ],
    result: 'the answer, in a few sentences, and where the report is',
    notInOutcome: '  copy the report into it.',
    doneLine: () => [],
    nextRound: () => ['  For a new round, do the work, rewrite outcome.md, and report done again.'],
    closing: [
      '- This is an explore shift: investigate and write it up. Build it, run it, break it if',
      '  that is what answering the question takes - the tree is thrown away, and nothing',
      '  you change in it outlives the shift.',
    ],
  },
  uix: {
    branchLine: () => ' It stays local: do not push it, and open no merge request.',
    deliverableLine: [
      '  Here the artifacts are the deliverable: the designs and prototypes you make go there.',
    ],
    handover: [
      '  takes your work to user and decides what comes next. Say what the artifacts',
      '  cannot show on their own:',
    ],
    result: 'what you made, in a few sentences, and where to look at it',
    notInOutcome: '  describe the artifacts one by one.',
    doneLine: () => [],
    nextRound: () => ['  For a new round, do the work, rewrite outcome.md, and report done again.'],
    closing: [
      '- This is a uix shift: user alone looks at what you made, and accepts it or asks for',
      '  another round.',
    ],
  },
};

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
  shiftBranch: string;
  taskDir: string;
  work: string;
  skills: readonly string[];
  scenario: Scenario;
}): string {
  const { sid, task, unit, data, tree, clone, shiftBranch, taskDir, skills } = options;
  const home = yanHome();
  const order = WORK_ORDERS[options.scenario];
  const places: Places = { branch: shiftBranch, base: data.branch, home };
  const lines = [
    `# ${sid} ${unit} (task ${task})`,
    '',
    '| | |',
    '| --- | --- |',
    `| unit | ${unit} |`,
    `| repo | ${data.repo} |`,
    `| worktree | ${tree} |`,
    `| shift branch | ${shiftBranch} |`,
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
    `- You are on ${shiftBranch}, which was cut from ${data.branch}.${order.branchLine(places)}`,
    `- Run the project's install step first, every time. The tree may be warm from an`,
    '  earlier shift, in which case it finishes in seconds with nothing to do.',
    '- Artifacts go in $YAN_TASK_DIR/artifacts',
    `  (${taskDir}/artifacts), NEVER inside the worktree: the tree is wiped when it is`,
    '  returned, so anything left in it is destroyed or accidentally committed. An',
    '  artifact is a by-product that helps yan and user understand the work - research',
    '  findings, prototypes, designs, screenshots that show the result.',
    ...order.deliverableLine,
    '- Throwaway state - build output, a browser profile, a scratch database, logs - is',
    '  not an artifact. Put it in the system temp directory, so it is neither committed',
    '  nor kept.',
    '- Before you report done, write $YAN_SHIFT_DIR/outcome.md',
    `  (${taskDir}/shifts/${sid}/outcome.md): the handover yan reads before it`,
    ...order.handover,
    `      Result        ${order.result}`,
    '      Reading       where the brief was ambiguous or silent, and what you chose',
    '      Deviations    where you did not do what the brief said, and why',
    '      Learnings     problems you hit and how you solved them, above all what cost real time',
    '      Left over     what is unfinished, and problems you saw outside scope but did not touch',
    '      Verification  how you checked it, and what you could not check',
    '      Artifacts     what you left in $YAN_TASK_DIR/artifacts',
    '  Leave out a section with nothing in it. Do not restate the brief, and do not',
    order.notInOutcome,
    '  If yan sends you more work after that, rewrite the file before you report done',
    '  again. `yan report done` refuses until the file exists.',
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
    ...order.doneLine(places),
    '- yan answers with a line in your conversation, which may name a file; read it',
    '  and carry on. Another round is the same shift, you, so stay until yan clocks',
    '  you out. Reporting done ends a round, not the shift. After done, wait quietly:',
    '  yan may take a while to come back.',
    ...order.nextRound(places),
    '- The scope in the table above is where this work belongs. Going outside it is not',
    "  forbidden, but it is not yours to decide quietly: report it, say what you need and",
    '  why, and let yan answer.',
    ...order.closing,
  ];
  return `${lines.join('\n')}\n`;
}
