/** The values a chart draws, as a table only a screen reader sees. A chart is not given an
 *  image role, which would hide its tooltip and every link inside it; the table is how someone who
 *  cannot see the plot reads each day's value, and each gap's reason. */
export function ChartDataTable({ caption, labelColumn = 'Date', columns, rows }: {
  caption: string;
  /** What the first column holds; a dated chart keeps the default. */
  labelColumn?: string;
  columns: readonly string[];
  rows: ReadonlyArray<{ label: string; cells: readonly string[] }>;
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{labelColumn}</th>
          {columns.map(c => <th key={c} scope="col">{c}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.label}>
            <th scope="row">{r.label}</th>
            {r.cells.map((cell, i) => <td key={columns[i] ?? i}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
