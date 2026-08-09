#!/usr/bin/env node
// soft-path.mjs - the interactive half of yan, for `user` and nobody else
// (td cli-ux.md; architecture.md §2 "ui/ collects answers, then yan with full
// flags").
//
// ---------------------------------------------------------------------------
// THE ONE THING THIS FILE MAY DO
// ---------------------------------------------------------------------------
//
// Ask questions, then run `yan <cmd>` with a complete set of flags. It never
// writes task.json, never opens a container, never merges anything, and never
// decides what a value should be when nobody said. Every irreversible step
// stays in the shell scripts, which is what makes the soft path a convenience
// rather than a second implementation of yan (cli-ux.md §2).
//
// It is also NOT a second entry point for agents. Agents already know their
// arguments; they call `yan <cmd> --flags` directly and never need node. The
// shell only ever gets here when stdin is a TTY and something is missing; the
// lib-ui launcher holds that rule.
//
//   node soft-path.mjs task-new [--title T] [--description D] [--id I] [--agent A]
//   node soft-path.mjs continue [--agent A]
//
// Two environment variables exist for tests, because a test cannot conjure up
// a terminal and Clack needs one:
//
//   YAN_UI_TEST_ANSWERS=<file>  answer every prompt from this JSON file
//   YAN_UI_PRINT_ONLY=1         print the assembled argv instead of running it
//
// They short-circuit the prompts only. Everything downstream of the last
// answer - the argument assembly that is the actual contract with `bin/` - is
// the same code either way.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  readRepos,
  detectMonorepo,
  scopeChoices,
  unitsForRepo,
  buildTaskNewArgs,
  buildContinueArgs,
  incompleteTasks,
} from './lib/plan.mjs';

const YAN_HOME = process.env.YAN_HOME;
const YAN_BIN = process.env.YAN_BIN || (YAN_HOME ? path.join(YAN_HOME, 'bin', 'yan') : 'yan');
const SHELL = process.env.YAN_UI_SHELL || 'bash';

function die(message, code = 1) {
  process.stderr.write(`yan ui: ${message}\n`);
  process.exit(code);
}

if (!YAN_HOME) die('YAN_HOME is not set - run this through bin/yan, never directly', 2);

// --- known-in-advance values -------------------------------------------------

function parseFlags(argv) {
  const known = new Set(['--title', '--description', '--id', '--agent']);
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!known.has(argv[i])) continue;
    out[argv[i].slice(2)] = argv[i + 1] ?? '';
    i += 1;
  }
  return out;
}

// --- running yan -------------------------------------------------------------

function runYan(argv) {
  const res = spawnSync(SHELL, [YAN_BIN, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, YAN_UI: '1' },
  });
  if (res.error) die(`cannot run ${YAN_BIN}: ${res.error.message}`);
  process.exit(res.status === null ? 1 : res.status);
}

function readYanJson(argv) {
  const res = spawnSync(SHELL, [YAN_BIN, ...argv], { encoding: 'utf8', env: process.env });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

function handOff(argv) {
  if (process.env.YAN_UI_PRINT_ONLY === '1') {
    process.stdout.write(`${JSON.stringify(argv)}\n`);
    process.exit(0);
  }
  runYan(argv);
}

// --- the prompt layer --------------------------------------------------------
//
// Clack is imported lazily so that the scripted path used by the tests never
// needs it, and so that a missing install produces one sentence instead of a
// module-resolution stack trace (node_modules/ is gitignored: "not installed
// yet" is the ordinary state of a fresh clone).

const scripted = process.env.YAN_UI_TEST_ANSWERS
  ? JSON.parse(fs.readFileSync(process.env.YAN_UI_TEST_ANSWERS, 'utf8'))
  : null;

let clack = null;
async function prompts() {
  if (scripted) return null;
  if (clack) return clack;
  try {
    clack = await import('@clack/prompts');
  } catch {
    die(
      `@clack/prompts is not installed - run: (cd ${path.join(YAN_HOME, 'ui')} && npm install)`,
      1,
    );
  }
  return clack;
}

function cancelled(value) {
  return value === null || value === undefined;
}

async function askText(key, { message, placeholder, allowEmpty = false }) {
  if (scripted) return scripted[key] ?? '';
  const p = await prompts();
  const answer = await p.text({
    message,
    placeholder,
    validate: allowEmpty
      ? undefined
      : (v) => (v && v.trim() ? undefined : 'this one cannot be empty'),
  });
  if (p.isCancel(answer)) return null;
  return String(answer ?? '').trim();
}

async function askSelect(key, { message, options }) {
  if (scripted) return scripted[key];
  const p = await prompts();
  const answer = await p.select({ message, options });
  if (p.isCancel(answer)) return null;
  return answer;
}

async function askMulti(key, { message, options, required = true, initialValues }) {
  if (scripted) return scripted[key];
  const p = await prompts();
  const answer = await p.multiselect({ message, options, required, initialValues });
  if (p.isCancel(answer)) return null;
  return answer;
}

async function say(message) {
  if (scripted) return;
  const p = await prompts();
  p.note(message);
}

async function start(message) {
  if (scripted) return;
  const p = await prompts();
  p.intro(message);
}

function giveUp(what) {
  process.stderr.write(`yan ui: cancelled - ${what}\n`);
  process.exit(1);
}

// --- yan task new ------------------------------------------------------------
//
// cli-ux.md §3, in order: title -> description -> repositories -> per-repo
// scope -> target -> persist -> ENTER. The last two are bin/yan-task-new.sh's
// job; everything above the line is this function's.

async function taskNew(flags) {
  await start('yan task new');

  const title = flags.title ?? (await askText('title', { message: 'What is this task called?' }));
  if (cancelled(title)) giveUp('no task was created');

  const description =
    flags.description ??
    (await askText('description', {
      message: 'Describe it (optional)',
      placeholder: 'leave empty to skip',
      allowEmpty: true,
    }));
  if (cancelled(description)) giveUp('no task was created');

  const repos = readRepos(YAN_HOME);
  if (repos.length === 0) {
    die('no repositories are registered - run `yan repo-add <url>` first, then create the task', 2);
  }

  const chosen = await askMulti('repos', {
    message: 'Which repositories does this task involve?',
    options: repos.map((r) => ({ value: r.name, label: r.name, hint: r.url })),
  });
  if (cancelled(chosen) || chosen.length === 0) giveUp('a task involves at least one repository');

  const units = [];
  const usedNames = new Set();

  for (const name of chosen) {
    const repo = repos.find((r) => r.name === name);
    const detection = detectMonorepo(repo.dir);

    let scopes = [];
    if (detection.monorepo) {
      const picked = await askMulti(`scopes.${name}`, {
        message: `${name}: which packages are in scope?`,
        options: scopeChoices(detection),
        required: true,
      });
      if (cancelled(picked)) giveUp('no task was created');
      scopes = picked;
    } else if (scripted) {
      scopes = scripted[`scopes.${name}`] ?? [];
    }

    // target has NO default and is never invented (branching.md §6.4). The
    // soft path asks; it does not guess.
    const target = await askText(`target.${name}`, {
      message: `${name}: which branch does this deliver into?`,
      placeholder: 'master',
    });
    if (cancelled(target)) giveUp('no task was created');

    units.push(...unitsForRepo({ repo: name, scopes, target }, usedNames));
  }

  const argv = buildTaskNewArgs({
    id: flags.id,
    title,
    description,
    units,
    agent: flags.agent,
  });

  await say(
    `${units.length} unit(s): ${units
      .map((u) => `${u.unit} (${u.repo}${u.scope.length ? `/${u.scope[0]}` : ''} → ${u.target})`)
      .join(', ')}`,
  );

  handOff(argv);
}

// --- yan continue ------------------------------------------------------------
//
// cli-ux.md §4: with no id, select among the INCOMPLETE tasks. The list is
// derived by `yan ls --json`, never by scanning tasks/ from here - one owner
// per piece of information.

async function continueTask(flags) {
  await start('yan continue');

  const ls = readYanJson(['ls', '--json']);
  if (!ls) die('cannot read the task list - try `yan ls` and fix what it reports');

  const open = incompleteTasks(ls);
  if (open.length === 0) {
    die('there are no incomplete tasks to continue - `yan task new` starts one', 2);
  }

  const task = await askSelect('task', {
    message: 'Which task do you want to continue?',
    options: open.map((t) => ({
      value: t.id,
      label: `${t.id}  ${t.title || '(no title)'}`,
      hint: `${t.units.length} unit(s), ${t.shifts} live shift(s)`,
    })),
  });
  if (cancelled(task)) giveUp('nothing was opened');

  handOff(buildContinueArgs({ task, agent: flags.agent }));
}

// --- dispatch ----------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (command) {
  case 'task-new':
    await taskNew(flags);
    break;
  case 'continue':
    await continueTask(flags);
    break;
  default:
    die(`unknown soft path: ${command ?? '(none)'} - task-new or continue`, 2);
}
