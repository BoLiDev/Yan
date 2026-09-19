import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { YanError } from '../../util/error.js';
import { yanHome } from '../../util/home.js';
import type { Report } from './collect.js';

/**
 * The page `yan ui` writes: `templates/ui/report.html` with its one
 * placeholder filled by the report. The template is the design, finished and
 * fixed, so every page looks the same and nothing here writes markup.
 *
 * Both replacements take a function, not a string: `$&` in a deliverable is a
 * replacement pattern to `String.replace`.
 */

const PLACEHOLDER = '/*YAN_DATA*/';
/** Where the mock added its strip of links; the real page leaves the line out. */
const MOCK_LINE = /^[ \t]*<!--YAN_MOCK-->[ \t]*\r?\n?/m;

export function templatePath(): string {
  return join(yanHome(), 'templates', 'ui', 'report.html');
}

/**
 * The report as the JSON block's text: every `<` as its JSON escape, so no
 * value can end the script element or open a comment in it, and `JSON.parse`
 * still gives the same object back.
 */
export function dataBlock(report: Report): string {
  return JSON.stringify(report).replace(/</g, '\\u003c');
}

/** @throws YanError `ui_template` when the template has lost its placeholder. */
export function fillTemplate(template: string, report: Report): string {
  if (!template.includes(PLACEHOLDER)) {
    throw new YanError('ui_template', `the report template has no ${PLACEHOLDER} - is ${templatePath()} yan's own?`);
  }
  return template.replace(PLACEHOLDER, () => dataBlock(report)).replace(MOCK_LINE, () => '');
}

/** @throws YanError `ui_template` when the installed yan has no template. */
export function reportPage(report: Report): string {
  const path = templatePath();
  let template: string;
  try {
    template = readFileSync(path, 'utf8');
  } catch {
    throw new YanError('ui_template', `no report template at ${path}`);
  }
  return fillTemplate(template, report);
}
