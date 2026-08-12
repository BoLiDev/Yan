#!/usr/bin/env node
//
// First-time (or fresh-clone) bootstrap. Runs before `yan` is on PATH, so it
// stays a plain node script rather than a subcommand.
//
//   npm run setup              install, build, link, doctor
//   npm run setup -- --skip-doctor   stop before doctor
//
// Exit 0 on success, non-zero on the first step that failed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skipDoctor = process.argv.includes('--skip-doctor');

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

// The config used to be copied into conf/ here. It is not a machine-level file
// any more: `agents.*` and `remote_git.*` follow the CONTEXT — GitHub at home,
// an internal GitLab at work — so they live in the vault, and `yan vault init`
// lays one down from the same sample (docs/v3/td/vault.md §2).
//
// Setup does not create a vault. Which forge you deliver to is a decision, and
// a bootstrap script guessing it is exactly the guess V3 exists to stop.
const machineConfig = join(homedir(), '.yan', 'config.json');
const hasVault = existsSync(machineConfig);

if (!skipDoctor) {
  const yan = join(repoRoot, 'dist', 'cli', 'yan.js');
  step('yan doctor', () => {
    // No shell: process.execPath is often under "Program Files", and cmd splits on the space.
    run(process.execPath, [yan, 'doctor'], { ...process.env, YAN_HOME: repoRoot }, { shell: false });
  });
}

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
