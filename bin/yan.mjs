#!/usr/bin/env node
//
// yan - the entry point npm installs onto PATH, beside bin/yan, which stays a
// bash script and cannot be npm's `bin` target: npm's Windows shim hands bash
// a Windows path, which bash reads as escape sequences.
//
//   1  find $YAN_HOME
//   2  check the one remaining hard dependency
//   3  spawn dist/cli/yan.js, with the ORIGINAL words
//
// Spawned rather than imported: dist/cli/yan.js only runs when process.argv[1]
// ends in `yan.js`, so importing it from here would do nothing at all.
//

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function die(message) {
  process.stderr.write(`yan: ${message}\n`);
  process.exit(1);
}

const isYanHome = (dir) => dir !== undefined && existsSync(join(dir, 'bin', 'yan'));

// An exported $YAN_HOME wins, but only when it really is a yan home.
const exported = process.env.YAN_HOME;
const YAN_HOME = isYanHome(exported)
  ? resolve(exported)
  : dirname(dirname(fileURLToPath(import.meta.url)));
process.env.YAN_HOME = YAN_HOME;

// The forge CLI and herdr belong to `yan doctor`; git is needed before that.
const git = spawnSync('git', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
if (git.status !== 0) {
  die("missing required dependency: git - install it, then run 'yan doctor'");
}

const YAN_ROOT_JS = join(YAN_HOME, 'dist', 'cli', 'yan.js');
if (!existsSync(YAN_ROOT_JS)) {
  die(`${YAN_ROOT_JS} is missing - run 'npm run build' in ${YAN_HOME}`);
}

const run = spawnSync(process.execPath, [YAN_ROOT_JS, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(run.status ?? 1);
