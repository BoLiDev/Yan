/**
 * Column alignment for the human renderings.
 *
 * Rows are tab-separated, the first row is the header, and the last column is
 * never padded — trailing spaces at end of line are noise in a terminal and in
 * a diff. Empty cells become a dash so the columns stay visible.
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

/** Empty becomes a dash, so a missing value is visible rather than invisible. */
export function dash(value: string | undefined | null): string {
  return value === undefined || value === null || value === '' ? '-' : value;
}
