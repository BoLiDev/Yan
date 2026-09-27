/**
 * How each agent CLI yan runs is started: the executable, and the flags that
 * pick a model and an effort.
 */

/** The executable's name without directory or `.exe`: `claude`, `codex`, `agy`. */
export function cliKind(cli: string): string {
  const first = cli.trim().split(/\s+/)[0] ?? '';
  return (first.split(/[\\/]/).pop() ?? first).replace(/\.exe$/, '');
}

/**
 * The flags that set a model and an effort, in the spelling `cli` takes.
 * `[]` for a CLI yan does not know, which `yan doctor` reports.
 */
export function modelFlags(cli: string, spec: { readonly model: string; readonly effort: string }): string[] {
  const kind = cliKind(cli);
  const args: string[] = [];
  if (kind === 'claude' || kind === 'agy') {
    if (spec.model !== '') args.push('--model', spec.model);
    if (spec.effort !== '') args.push('--effort', spec.effort);
  } else if (kind === 'codex') {
    if (spec.model !== '') args.push('-m', spec.model);
    // A bare value is taken as a literal string when it is not TOML.
    if (spec.effort !== '') args.push('-c', `model_reasoning_effort=${spec.effort}`);
  }
  return args;
}
