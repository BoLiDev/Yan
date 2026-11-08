#!/usr/bin/env node
/**
 * A world of its own for one monkey to walk yan in: two machines, a vault
 * shared between them through a local origin, two repositories to work in,
 * and an agent CLI that only says what it was started with. Nothing in it
 * reaches the user's own vault, ~/.yan, herdr, browser or forge.
 *
 *   node .claude/skills/monkey/sandbox.mjs <dir> [--empty]
 *
 * <dir> must not exist yet, and must not be inside a git work tree: `yan repo
 * add` with no target looks for the clone it is run in, and would find the
 * one around the sandbox. `--empty` leaves out the seeded tasks.
 *
 * It runs the build in dist/ as it is, copied, so a rebuild of the checkout
 * mid-walk does not move under a running `yan serve`. It refuses a dist/
 * older than src/ or web/src/, since a walk of a stale build finds stale bugs.
 *
 * Every command after the layout goes through yan itself, so a sandbox that
 * cannot be made is the first finding; the step that failed is printed with
 * its output.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const node = process.execPath;

const args = process.argv.slice(2);
const empty = args.includes('--empty');
const target = args.find((a) => !a.startsWith('--'));
if (target === undefined) fail('usage: node .claude/skills/monkey/sandbox.mjs <dir> [--empty]');
const root = resolve(target);

function fail(message) {
  process.stderr.write(`sandbox: ${message}\n`);
  process.exit(1);
}

function newest(dir) {
  let best = 0;
  if (!existsSync(dir)) return best;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    const s = statSync(path);
    best = Math.max(best, s.isDirectory() ? newest(path) : s.mtimeMs);
  }
  return best;
}

// --- refuse what would make the walk meaningless or unsafe --------------------

if (!existsSync(join(repoRoot, 'dist', 'cli', 'yan.js')) || !existsSync(join(repoRoot, 'dist', 'web'))) {
  fail(`no build in ${join(repoRoot, 'dist')}: run 'npm run build' first`);
}
const built = newest(join(repoRoot, 'dist'));
const edited = Math.max(newest(join(repoRoot, 'src')), newest(join(repoRoot, 'web', 'src')), newest(join(repoRoot, 'plugin')));
if (edited > built) fail("dist/ is older than the source: run 'npm run build' first");
if (existsSync(root) && readdirSync(root).length > 0) fail(`${root} is not empty`);
{
  let up = dirname(root);
  while (!existsSync(up)) up = dirname(up);
  const inside = spawnSync('git', ['-C', up, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inside.stdout.trim() === 'true') fail(`${root} is inside a git work tree; put the sandbox outside any repository`);
}

// --- the layout ---------------------------------------------------------------

const p = {
  code: join(root, 'code'),
  fakeBin: join(root, 'fake-bin'),
  origin: join(root, 'origin'),
  calls: join(root, 'agent-calls.jsonl'),
  machine: (m) => join(root, m),
  home: (m) => join(root, m, 'home'),
  bin: (m) => join(root, m, 'bin'),
  vault: (m) => join(root, m, 'vault'),
  work: (m) => join(root, m, 'work'),
  env: (m) => join(root, `env-${m}.sh`),
};

mkdirSync(root, { recursive: true });
for (const d of ['bin', 'templates', 'plugin', 'dist']) cpSync(join(repoRoot, d), join(p.code, d), { recursive: true });
cpSync(join(repoRoot, 'package.json'), join(p.code, 'package.json'));
symlinkSync(join(repoRoot, 'node_modules'), join(p.code, 'node_modules'), 'dir');

function script(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// An agent CLI that records what it was started with, then does what the walk
// asks of it: $MONKEY_AGENT_DO, a shell snippet run in the directory it was
// started in, with the environment yan gave it. claude also runs the hooks yan
// handed it in --settings, the prompt hook before and the stop hook after, as
// claude would around one turn, so the vault's pull and push are exercised.
const fakeAgent = (cli) => `#!${node}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('YAN_') || k.startsWith('HERDR_')));
const at = argv.indexOf('--settings');
let hooks = {};
try { hooks = at < 0 ? {} : JSON.parse(argv[at + 1]).hooks ?? {}; } catch {}
const hook = (name) => {
  const command = hooks[name]?.[0]?.hooks?.[0]?.command;
  if (command === undefined) return undefined;
  const r = spawnSync(command, { shell: true, encoding: 'utf8', input: '{}' });
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
};
const record = { at: new Date().toISOString(), cli: ${JSON.stringify(cli)}, cwd: process.cwd(), argv, env, stdinTTY: process.stdin.isTTY === true };
record.promptHook = hook('UserPromptSubmit');
const todo = process.env.MONKEY_AGENT_DO;
if (todo) {
  const r = spawnSync(todo, { shell: true, stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' });
  record.did = { snippet: todo, status: r.status, out: (r.stdout + r.stderr).trim() };
  process.stdout.write(r.stdout + r.stderr);
}
record.stopHook = hook('Stop');
appendFileSync(${JSON.stringify(p.calls)}, JSON.stringify(record) + '\\n');
process.stdout.write('[fake ${cli}] started in ' + process.cwd() + '; recorded in ${p.calls}\\n');
process.exit(Number(process.env.MONKEY_AGENT_EXIT ?? 0));
`;
for (const cli of ['claude', 'codex', 'agy']) script(join(p.fakeBin, cli), fakeAgent(cli));

// No herdr but the fake one herdr.mjs starts: a real one would open tabs in the user's own workspace.
script(join(p.fakeBin, 'herdr'), '#!/bin/sh\necho "herdr: not in this sandbox (start .claude/skills/monkey/herdr.mjs for a fake one)" >&2\nexit 127\n');

// $EDITOR for `yan draft`: appends $MONKEY_EDITOR_TEXT to the file it is given, or a line saying when.
script(join(p.fakeBin, 'editor'), `#!${node}
const { appendFileSync } = require('node:fs');
const file = process.argv.at(-1);
appendFileSync(file, (process.env.MONKEY_EDITOR_TEXT ?? 'written by the sandbox editor at ' + new Date().toISOString()) + '\\n');
`);

// dice: one of its arguments at random, or with a single number n, 1..n.
script(join(p.fakeBin, 'dice'), `#!${node}
const a = process.argv.slice(2);
const n = a.length === 1 && /^\\d+$/.test(a[0]) ? Number(a[0]) : 0;
console.log(n > 0 ? 1 + Math.floor(Math.random() * n) : a[Math.floor(Math.random() * a.length)] ?? '');
`);

const gitconfig = `[user]
\tname = monkey
\temail = monkey@sandbox.invalid
[init]
\tdefaultBranch = main
[commit]
\tgpgsign = false
[tag]
\tgpgsign = false
[advice]
\tdetachedHead = false
[protocol "file"]
\tallow = always
`;

for (const m of ['a', 'b']) {
  mkdirSync(p.home(m), { recursive: true });
  writeFileSync(join(p.home(m), '.gitconfig'), gitconfig);
  // The machine itself: its home, its ~/.yan, and a PATH that finds this
  // machine's yan and the fakes first. Sourced by everything below.
  const machine = join(p.machine(m), 'machine.sh');
  writeFileSync(machine, `export SANDBOX=${JSON.stringify(root)}
export MONKEY_MACHINE=${m}
export HOME=${JSON.stringify(p.home(m))}
export YAN_HOME=${JSON.stringify(p.code)}
export YAN_MACHINE_DIR=${JSON.stringify(join(p.home(m), '.yan'))}
export YAN_OPENER=''
export GIT_CONFIG_NOSYSTEM=1
export EDITOR=${JSON.stringify(join(p.fakeBin, 'editor'))}
export VISUAL="$EDITOR"
export NO_COLOR=1
case ":$PATH:" in *:${p.bin(m)}:*) ;; *) export PATH=${JSON.stringify(`${p.bin(m)}:${p.fakeBin}`)}:"$PATH" ;; esac
`);
  // What the walker's own shell may have handed down that names a task, a
  // vault, a pool or a herdr pane: a Claude Code started through bare yan has
  // $YAN_VAULT set to the user's real vault, which would win over ~/.yan.
  const forget = `for v in $(env | sed -n 's/^\\(YAN_[A-Za-z0-9_]*\\)=.*/\\1/p; s/^\\(HERDR_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$v"; done`;
  const yanJs = `exec ${JSON.stringify(node)} ${JSON.stringify(join(p.code, 'bin', 'yan.mjs'))} "$@"`;
  const intoWork = `case "$PWD/" in ${JSON.stringify(`${root}/`)}*) ;; *) cd ${JSON.stringify(p.work(m))} ;; esac`;
  writeFileSync(p.env(m), `# Machine ${m.toUpperCase()} of the sandbox in ${root}. Source it: . ${p.env(m)}\n${forget}\n. ${JSON.stringify(machine)}\n${intoWork}\n`);
  // The yan an agent started in the sandbox finds on its PATH: it keeps the
  // $YAN_TASK and $YAN_VAULT yan gave it, and the directory it is run in.
  script(join(p.bin(m), 'yan'), `#!/bin/sh\n. ${JSON.stringify(machine)}\n${yanJs}\n`);
  // The walker's: nothing inherited, and run in the machine's work folder unless already somewhere in the sandbox.
  script(join(root, `yan-${m}`), `#!/bin/sh\n${forget}\n. ${JSON.stringify(machine)}\n${intoWork}\n${yanJs}\n`);
  mkdirSync(p.work(m), { recursive: true });
}

// --- run things in it ----------------------------------------------------------

function sh(m, command, { cwd, env = {}, ok = true } = {}) {
  const r = spawnSync('/bin/sh', ['-c', `. ${JSON.stringify(p.env(m))} && ${cwd === undefined ? '' : `cd ${JSON.stringify(cwd)} && `}${command}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (ok && r.status !== 0) fail(`machine ${m}: '${command}' exited ${r.status}\n${r.stdout}${r.stderr}`);
  return r;
}

/** A command at a terminal, as bare yan needs: script(1) gives it one. */
function atTerminal(m, command, options) {
  const wrapped = process.platform === 'darwin'
    ? `script -q /dev/null /bin/sh -c ${JSON.stringify(command)} </dev/null`
    : `script -qec ${JSON.stringify(command)} /dev/null </dev/null`;
  return sh(m, wrapped, options);
}

function seedRepo(name, files) {
  const bare = join(p.origin, `${name}.git`);
  const seed = join(root, '.seed', name);
  sh('a', `git init -q --bare ${JSON.stringify(bare)}`);
  mkdirSync(seed, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, rel)), { recursive: true });
    writeFileSync(join(seed, rel), body);
  }
  sh('a', `git init -q && git add -A && git commit -qm 'initial commit' && git remote add origin ${JSON.stringify(bare)} && git push -q -u origin main`, { cwd: seed });
  return bare;
}

const web = seedRepo('web', {
  'package.json': `${JSON.stringify({ name: 'web', private: true, scripts: { dev: 'node server.js' } }, null, 2)}\n`,
  'server.js': "require('node:http').createServer((q, s) => s.end('<h1>web</h1>')).listen(process.env.PORT ?? 3000);\n",
  'src/app.js': 'export const greet = (name) => `hello ${name}`;\n',
  'README.md': '# web\n\nA small app for the monkey to work in.\n',
});
const mono = seedRepo('mono', {
  'package.json': `${JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*', 'apps/*'] }, null, 2)}\n`,
  'packages/core/package.json': '{ "name": "@mono/core" }\n',
  'packages/core/index.js': 'export const add = (a, b) => a + b;\n',
  'packages/ui/package.json': '{ "name": "@mono/ui" }\n',
  'packages/ui/button.js': "export const button = (label) => `<button>${label}</button>`;\n",
  'apps/site/package.json': '{ "name": "site" }\n',
  'apps/site/index.html': '<!doctype html><title>site</title>\n',
});
const vaultOrigin = join(p.origin, 'vault.git');
sh('a', `git init -q --bare ${JSON.stringify(vaultOrigin)}`);

for (const m of ['a', 'b']) {
  sh(m, `git clone -q ${JSON.stringify(web)} web && git clone -q ${JSON.stringify(mono)} mono`, { cwd: p.work(m) });
}

sh('a', `yan vault init monkey --remote ${JSON.stringify(vaultOrigin)} --path ${JSON.stringify(p.vault('a'))}`);
sh('a', 'yan repo add web && yan repo add mono && yan vault push', { cwd: p.work('a') });
sh('b', `yan vault clone ${JSON.stringify(vaultOrigin)} --path ${JSON.stringify(p.vault('b'))}`);
sh('b', `yan repo link web ${JSON.stringify(join(p.work('b'), 'web'))} && yan repo link mono ${JSON.stringify(join(p.work('b'), 'mono'))}`);

// --- a few tasks to find, unless asked for none ---------------------------------

if (!empty) {
  // A task in web, its agent keeping notes as one would on its first turn.
  atTerminal('a', `yan --new '首页加载太慢' --repo web`, {
    env: {
      MONKEY_AGENT_DO: [
        "yan deliverable add '首页首屏在 1 秒内出现'",
        "yan deliverable add '慢请求在日志里有记录'",
        "yan log agreed '先只看首屏，不碰后端'",
        "yan resource add spec ticket https://example.invalid/tickets/42",
        "printf '# 背景\\n\\n首页在慢网下要等 5 秒。\\n' > \"$YAN_VAULT/tasks/$YAN_TASK/problem.md\"",
        "git switch -q -c perf/first-paint && yan branch",
        "echo 'export const lazy = true;' >> src/app.js && git commit -qam 'lazy first paint'",
        "yan say '首屏的改动做完了一半，等你看一下方向'",
      ].join(' && '),
    },
  });
  // A task in the monorepo, about one package.
  atTerminal('a', `yan --new 'core: add 要处理字符串' --repo mono:packages/core`, {
    env: { MONKEY_AGENT_DO: "yan deliverable add 'add 遇到字符串时报错而不是拼接'" },
  });
  // A task with no repository, made on the other machine once it has A's, and put aside there.
  sh('b', 'yan vault pull');
  atTerminal('b', `yan --new 'Write the release notes' --no-repo`, {
    env: { MONKEY_AGENT_DO: "yan deliverable add 'Release notes cover every merged change' && yan log agreed 'English, one page' && yan pause \"$YAN_TASK\"" },
  });
  sh('b', 'yan vault push');
  sh('a', 'yan vault pull');
  atTerminal('a', 'yan draft --title "想法：任务列表按仓库分组"', { env: { MONKEY_EDITOR_TEXT: '- 也许按仓库分组\n- 也许按状态' } });
  // Every seeded agent's snippet has to have worked, or the walk starts from a world that is not what it says.
  const calls = readFileSync(p.calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const c of calls) {
    if (c.did !== undefined && c.did.status !== 0) fail(`a seeded agent's turn failed in ${c.cwd}:\n${c.did.snippet}\n${c.did.out}`);
  }
}

// --- what the walker reads -------------------------------------------------------

const readme = `# The sandbox in ${root}

Two machines share one vault through a local origin. Nothing here reaches the
user's own vault, ~/.yan, herdr, browser or forge, as long as yan is run
through these and never through the \`yan\` on the PATH outside.

  ${join(root, 'yan-a')} <args>     yan on machine A, run in A's work folder
  ${join(root, 'yan-b')} <args>     yan on machine B
  . ${p.env('a')}                   machine A for the rest of one shell command:
                                    HOME, ~/.yan, PATH (yan, a fake claude/codex/agy,
                                    a fake herdr, $EDITOR) and cwd ${p.work('a')}

Each shell command starts afresh, so source the env file in every command
that needs more than yan: \`. ${p.env('a')} && git -C web log --oneline\`.

Machine A: vault ${p.vault('a')}, clones ${p.work('a')}/{web,mono}, ~/.yan ${join(p.home('a'), '.yan')}
Machine B: vault ${p.vault('b')}, clones ${p.work('b')}/{web,mono}, ~/.yan ${join(p.home('b'), '.yan')}
Origins:   ${p.origin}/{vault,web,mono}.git (mono declares packages/* and apps/* as workspaces)

The agent CLIs are fakes. Each start appends one JSON line to
${p.calls}: its argv, cwd, the YAN_* variables it was given, and
what its hooks and $MONKEY_AGENT_DO did. To have the "agent" do something
during its turn, set MONKEY_AGENT_DO to a shell snippet (it runs in the
worktree, with the agent's environment, so \`yan say hi\` there acts on the task);
MONKEY_AGENT_EXIT sets its exit status. Bare \`yan\` needs a terminal: give it
one with tmux (interactive) or script(1) (flags only):

  tmux new-session -d -s m1 -x 120 -y 40 "${join(root, 'yan-a')}"
  tmux send-keys -t m1 Down Enter; tmux capture-pane -pt m1
  script -qec "${join(root, 'yan-a')} --new 'title' --no-repo" /dev/null </dev/null

\`yan draft\` writes through $EDITOR, here a fake that appends
$MONKEY_EDITOR_TEXT. \`dice a b c\` (or \`dice 6\`) picks at random.

yan serve: \`${join(root, 'yan-a')} serve --no-open --port <p> --every 2\`, left
running in the background, then Chromium through Playwright (require('playwright')
from ${repoRoot}). herdr's features need the fake one:
\`node ${join(repoRoot, '.claude', 'skills', 'monkey', 'herdr.mjs')} ${root} <task-id>\`.
`;
writeFileSync(join(root, 'SANDBOX.md'), readme);
process.stdout.write(readme);
