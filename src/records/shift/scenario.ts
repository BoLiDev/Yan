/**
 * What a scenario delivers. `coding` ends in a merge request into the
 * integration branch; `explore` and `uix` end in a report and artifacts, and
 * never push. There is no third shape: a coding shift that finds nothing to
 * change says so and is clocked out with --nothing-to-merge.
 */
export function opensMr(scenario: string): boolean {
  return scenario === 'coding';
}
