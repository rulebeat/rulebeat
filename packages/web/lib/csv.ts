/**
 * Shared CSV cell encoder for every export. No imports, so client components can use it.
 *
 * Two guarantees: a cell never starts with a character a spreadsheet reads as a formula
 * (= + - @ tab CR), and a cell holding a comma, quote, LF or CR is quoted so it cannot split a
 * row. Rule titles, resource names and evidence values are controlled by whoever authored the
 * rule or owns the Azure resource, so every exported cell goes through here.
 */
export function csvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  let s = typeof val === 'object' ? JSON.stringify(val) : String(val);
  // Only text can be a formula; a number such as -5 is left as the number it is.
  if (typeof val === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One CSV row (header or data), each cell guarded by csvCell. A column name comes from the same
 * untrusted sources a data cell can (an evidence key from a rule query, a query result column),
 * so a header row must be encoded exactly the way a data row is.
 */
export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}
