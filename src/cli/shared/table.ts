/** A missing or empty value as a dash. */
export function dash(value: string | undefined | null): string {
  return value === undefined || value === null || value === '' ? '-' : value;
}
