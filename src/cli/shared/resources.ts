import { cells, padEnd } from './style.js';

/** One line per resource, `  <name>  <where>`, the names padded to one column. */
export function resourceLines(resources: Readonly<Record<string, string>>): string[] {
  const entries = Object.entries(resources);
  const width = Math.max(0, ...entries.map(([name]) => cells(name)));
  return entries.map(([name, where]) => `  ${padEnd(name, width)}  ${where}`);
}
