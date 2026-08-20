'use client';

import { Table, TableScroll, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table';

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

interface ResultTableProps {
  rows: Record<string, unknown>[];
}

export function ResultTable({ rows }: ResultTableProps) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];

  return (
    <TableScroll>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map(col => <TableHead key={col}>{col}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableEmpty colSpan={Math.max(columns.length, 1)}>No rows returned.</TableEmpty>
          ) : (
            rows.map((row, i) => (
              <TableRow key={i}>
                {columns.map(col => <TableCell key={col}>{formatCell(row[col])}</TableCell>)}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableScroll>
  );
}
