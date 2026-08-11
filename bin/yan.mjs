#!/usr/bin/env node
//
// yan - the entry point npm installs onto PATH.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS ALONGSIDE bin/yan
// ---------------------------------------------------------------------------
//
// bin/yan is the path baked into .claude/settings.json, .codex/hooks.json,
// every shift's brief and AGENTS.md, and it stays a bash script for the reason
// written at the top of it. It cannot also be the npm `bin` target: npm's
// Windows shim reads the shebang, sees bash, and hands bash a Windows path,
// which bash reads as escape sequences -
//
//     /bin/bash: C:UserslibodAppDataRoamingnpm/node_modules/yan/bin/yan
//
// so the shim resolves nothing. A `#!/usr/bin/env node` shebang has no such
// problem on any platform, so PATH installs come through here instead.
//
// It does the same three things bin/yan does, minus the `node` check, which is
// answered by the fact that this file is running at all.
//
//   1  find $YAN_HOME
//   2  check the one remaining hard dependency
//   3  spawn the compiled root, with the ORIGINAL words
//
// Step 3 spawns rather than imports on purpose: dist/cli/yan.js only calls
// main() when process.argv[1] ends in `yan.js` (src/cli/yan.ts), so importing
// it from a file named anything else is a silent no-op.

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
