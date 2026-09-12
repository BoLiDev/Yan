/**
 * Narrowing `unknown` that came out of JSON someone else wrote — a task file,
 * a machine registry, another tool's stdout. Two questions get asked wherever
 * yan reads one, is this a record and is this a string, and both answer with a
 * value rather than throwing: every caller has a sane default for a field that
 * is missing or the wrong type, and none wants an exception from one.
 *
 * An array is not a record here. Every caller that asks is about to read named
 * fields, and `[].name` is a confident `undefined` rather than a refusal.
 */

/** The value as a record, or `undefined` when it is anything else. */
export function recordOrNone(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The value as a record; `{}` for anything else. */
export function asRecord(value: unknown): Record<string, unknown> {
  return recordOrNone(value) ?? {};
}

/** The value as a string, or `fallback`. */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
