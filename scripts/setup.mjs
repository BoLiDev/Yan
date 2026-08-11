#!/usr/bin/env node
//
// First-time (or fresh-clone) bootstrap. Runs before `yan` is on PATH, so it
// stays a plain node script rather than a subcommand.
//
//   npm run setup              install, build, link, copy config, doctor
//   npm run setup -- --skip-doctor   stop before doctor
//
// Exit 0 on success, non-zero on the first step that failed.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
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

const config = join(repoRoot, 'conf', 'config.json');
const sample = join(repoRoot, 'conf', 'config.sample.json');
step('conf/config.json', () => {
  if (existsSync(config)) {
    process.stdout.write(`  ${config} already exists — left unchanged\n`);
    return;
  }
  if (!existsSync(sample)) {
    process.stderr.write(`yan setup: missing ${sample}\n`);
    process.exit(1);
  }
  copyFileSync(sample, config);
  process.stdout.write(`  copied ${sample}\n`);
});

if (!skipDoctor) {
  const yan = join(repoRoot, 'dist', 'cli', 'yan.js');
  step('yan doctor', () => {
    // No shell: process.execPath is often under "Program Files", and cmd splits on the space.
    run(process.execPath, [yan, 'doctor'], { ...process.env, YAN_HOME: repoRoot }, { shell: false });
  });
}

process.stdout.write('\nSetup complete.\n');
if (existsSync(config) && !skipDoctor) {
  process.stdout.write('Edit conf/config.json if needed, then run yan from any directory.\n');
} else if (!skipDoctor) {
  process.stdout.write('Run yan doctor after editing conf/config.json.\n');
} else {
  process.stdout.write('Run yan doctor when you are ready.\n');
}
