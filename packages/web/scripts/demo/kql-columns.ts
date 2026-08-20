/**
 * A tiny, standalone paren-aware `| project` clause splitter — deliberately not
 * `parseKqlToVisualQuery()` from `@rulebeat/core`. That parser's own comma-splitter
 * (`kql.ts`) is not paren/bracket-depth-aware for project-clause aliases the way
 * `splitTopLevelPipes` is for pipes, so an expression like `param1=strcat('a:', x[0].y)`
 * would be split on the comma inside the function call. This generator only ever needs to
 * *read* a rule's own `rawKql` to learn the exact column names/expressions it projects
 * (so the fake ARG answer shape matches what the real query would return) — it never
 * needs to *write* KQL back out, so a small local helper is safer than depending on a
 * parser built for a different contract.
 *
 * It also sidesteps a known limitation of the real parser, tracked in the project's bug log.
 */

function splitTopLevelCommas(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  let strChar = '';

  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (inStr) {
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = true;
      strChar = ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(clause.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(clause.slice(start).trim());
  return parts.filter(Boolean);
}

export interface ProjectColumn {
  alias: string;
  expr: string;
}

/** Extracts `{alias, expr}` pairs from a rule's final `| project ...` line. A bare column name
 *  (no `=`) has `alias === expr`. Returns `[]` if the query has no project clause at all. */
export function extractProjectColumns(rawKql: string): ProjectColumn[] {
  const lines = rawKql.split('\n').map(l => l.trim());
  const projectLine = [...lines].reverse().find(l => l.startsWith('| project'));
  if (!projectLine) return [];

  const clause = projectLine.replace(/^\|\s*project\s*/, '');
  return splitTopLevelCommas(clause).map(part => {
    const eq = part.indexOf('=');
    // `==` is a comparison, not an assignment — only a single, non-doubled `=` splits alias/expr.
    if (eq === -1 || part[eq + 1] === '=' || part[eq - 1] === '!' || part[eq - 1] === '<' || part[eq - 1] === '>') {
      return { alias: part, expr: part };
    }
    return { alias: part.slice(0, eq).trim(), expr: part.slice(eq + 1).trim() };
  });
}
