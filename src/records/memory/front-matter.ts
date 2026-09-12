/**
 * The `name` and `description` a markdown file declares in its front matter:
 *
 * ```
 * ---
 * name: Integration branches
 * description: branches come from the ticket system, not from yan
 * ---
 * ```
 *
 * Understands `key: value` on one line, optionally quoted, inside a leading
 * `---` fence, and nothing else of YAML. A file with no front matter takes
 * `fileName` as its name and an empty description.
 */
export function frontMatter(fileName: string, text: string): { name: string; description: string } {
  const lines = text.split(/\r?\n/);
  const fields: Record<string, string> = {};

  if (lines[0]?.trim() === '---') {
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (line === '---') break;
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (match === null) continue;
      let value = (match[2] ?? '').trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      }
      fields[(match[1] as string).toLowerCase()] = value;
    }
  }

  const name = fields.name !== undefined && fields.name !== '' ? fields.name : fileName;
  return { name, description: fields.description ?? '' };
}
