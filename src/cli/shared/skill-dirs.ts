import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { YanError } from '../../util/error.js';
import { machineConfigPath, machineDir, skillDirs } from '../../util/machine.js';
import { isDirectory, samePath } from '../../util/paths.js';

/**
 * The plugin folders claude is started with besides yan's own: one for each
 * folder `skillDir` names in `~/.yan/config.json`.
 *
 * `--plugin-dir` takes a plugin, its skills in `skills/<name>/SKILL.md`, or a
 * folder of plugins; a folder that holds skills itself, `<name>/SKILL.md` as
 * `~/.claude/skills` does, loads nothing. Such a folder is handed over as a
 * plugin of its own under `~/.yan/skill-dirs/`, named after it, whose
 * `skills` is a link to the folder, so a skill added there is in the next
 * session with nothing to copy; a manifest's paths cannot leave the plugin,
 * so the link is the only way in. A junction on Windows, which needs no
 * administrator. Anything else is passed as it is, for claude to read.
 */
export function skillPlugins(): string[] {
  const taken = new Set<string>();
  return skillDirs().map((dir) => {
    if (!isDirectory(dir)) {
      throw YanError.usage('yan_skill_dir', `${dir} is not a folder - fix "skillDir" in ${machineConfigPath()}`);
    }
    if (!holdsSkills(dir)) return dir;
    let name = pluginName(dir);
    for (let n = 2; taken.has(name); n += 1) name = `${pluginName(dir)}-${n}`;
    taken.add(name);
    return wrapped(dir, name);
  });
}

/** A folder of skills, not a plugin: no manifest and no skills/, and a folder in it with a SKILL.md. */
function holdsSkills(dir: string): boolean {
  if (existsSync(join(dir, '.claude-plugin')) || existsSync(join(dir, 'skills'))) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((e) => existsSync(join(dir, e, 'SKILL.md')));
}

/** The folder's own name as claude spells a plugin's, which its skills are listed under: `<name>:<skill>`. */
function pluginName(dir: string): string {
  return basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skills';
}

/** `~/.yan/skill-dirs/<name>/`, its `skills` linked to `dir`, made again only where it is not so already. */
function wrapped(dir: string, name: string): string {
  const plugin = join(machineDir(), 'skill-dirs', name);
  const manifest = join(plugin, '.claude-plugin', 'plugin.json');
  const text = `${JSON.stringify({ name, description: `The skills in ${dir}, from skillDir in ${machineConfigPath()}` }, null, 2)}\n`;
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  if (readIfThere(manifest) !== text) writeFileSync(manifest, text);

  const link = join(plugin, 'skills');
  if (!linksTo(link, dir)) {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return plugin;
}

function readIfThere(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** True when `link` is a link that leads to `dir`; false when it is anything else or is not there. */
function linksTo(link: string, dir: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && samePath(realpathSync(link), realpathSync(dir));
  } catch {
    return false;
  }
}
