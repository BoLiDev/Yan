#!/usr/bin/env node
//
// First-time (or fresh-clone) bootstrap. Runs before `yan` is on PATH, so it
// stays a plain node script rather than a subcommand.
//
//   npm run setup              install, build, link
//
// Exit 0 on success, non-zero on the first step that failed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function step(label, fn) {
  process.stdout.write(`\n→ ${label}\n`);
  fn();
}

function run(command, args, env = process.env, { shell = false } = {}) {
  const r = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: shell && process.platform === 'win32',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function npm(args) {
  run('npm', args, process.env, { shell: true });
}

step('npm install', () => npm(['install']));
step('npm run build', () => npm(['run', 'build']));
step('npm link', () => npm(['link']));

// Setup creates no vault: where tasks are kept is `yan vault init`'s.
const machineConfig = join(homedir(), '.yan', 'config.json');
const hasVault = existsSync(machineConfig);

process.stdout.write('\nSetup complete.\n');
if (hasVault) {
  process.stdout.write('A vault is already registered on this machine — `yan vault ls` shows which.\n');
} else {
  process.stdout.write(
    [
      '',
      'One thing left: yan has nowhere to keep tasks yet. Create an empty',
      'repository on your forge, then:',
      '',
      '    yan vault init personal --remote <that repository>',
      '',
      'or, on a machine that should join a vault you already have:',
      '',
      '    yan vault clone <that repository>',
      '',
    ].join('\n'),
  );
}
