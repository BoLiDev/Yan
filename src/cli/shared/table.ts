/**
 * Pad each column to its widest cell, two spaces apart, prefixing every line
 * with `indent`. The last column is never padded, so no line ends in spaces.
 */
export function renderTable(rows: readonly (readonly string[])[], indent = ''): string[] {
  if (rows.length === 0) return [];

  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }

  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0) + '  '))
      .join('')
      .replace(/^/, indent),
  );
}

/** A missing or empty value as a dash. */
export function dash(value: string | undefined | null): string {
  return value === undefined || value === null || value === '' ? '-' : value;
}
