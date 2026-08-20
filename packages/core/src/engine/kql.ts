import type {
  AggFn, AggregateColumn, AggregateStage, ComputedColumn, ComputeStage,
  Condition, ConditionGroup, ConditionOperator, ExpandStage, FilterStage, JoinKind, JoinStage,
  LimitStage, Rule, RuleScope, ShapeStage, SortStage,
  VisualFilterCondition, VisualFilterGroup, VisualFilterOperator,
  VisualQuery, QueryStage,
} from './types.js';

// Columns included in every query when the user has not specified custom project columns.
export const DEFAULT_PROJECT_COLUMNS = [
  'id', 'name', 'type', 'location', 'resourceGroup', 'subscriptionId', 'tags',
];

// ── Shared helpers ────────────────────────────────────────────────────────────

function uid(): string {
  return typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto
    ? (globalThis.crypto as { randomUUID(): string }).randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function fieldToKqlExpr(field: string): string | null {
  const topLevel = ['id', 'name', 'type', 'location', 'subscriptionId', 'resourceGroup', 'kind', 'sku', 'plan', 'zones', 'identity', 'tags', 'tenantId', 'managedBy'];
  if (topLevel.includes(field)) return field;
  if (field.startsWith('tags.')) return `tags['${field.slice(5)}']`;
  if (field.startsWith('properties.') || field.startsWith('sku.') || field.startsWith('identity.') || field.startsWith('plan.')) return field;
  return null;
}

function kqlToField(expr: string): string {
  const t = expr.trim();
  const tagM = t.match(/^tags\s*\[['"](.+?)['"]\]$/);
  if (tagM) return `tags.${tagM[1] ?? ''}`;
  return t;
}

function scopeToTable(level: RuleScope['level']): string {
  switch (level) {
    case 'resource':         return 'Resources';
    case 'resourceGroup':    return "ResourceContainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups'";
    case 'subscription':     return "ResourceContainers | where type =~ 'microsoft.resources/subscriptions'";
    case 'managementGroup':  return "ResourceContainers | where type =~ 'microsoft.management/managementgroups'";
  }
}

// Split a string at top-level commas (not inside parens/brackets).
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * Splits one physical line at its `|` separators, ignoring pipes inside string literals or
 * parentheses. Returns the leading segment first, so `['Resources', "where name startswith 'vm-'"]`.
 */
function splitTopLevelPipes(line: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0, inStr = false, strChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === strChar) inStr = false; continue; }
    if (ch === "'" || ch === '"') { inStr = true; strChar = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '|' && depth === 0) {
      parts.push(line.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(line.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * True when the compiled query has a top-level `| take`, `| top` or `| limit` (an alias of take)
 * stage — i.e. its result set is capped by construction and can never be relied on to enumerate
 * every violation. Scans a multi-line query, tracking paren/bracket depth across lines so a
 * `take`/`top`/`limit` inside a join's subquery (wrapped in `(...)`) is not mistaken for a top-level
 * cap on the outer query.
 */
export function queryHasTopLevelLimit(kql: string): boolean {
  let depth = 0;
  for (const line of kql.split('\n')) {
    let start = 0, inStr = false, strChar = '';
    for (let i = 0; i <= line.length; i++) {
      const ch = i < line.length ? line[i] : undefined;
      if (i === line.length) {
        const seg = line.slice(start, i).trim();
        if (depth === 0 && /^(take|top|limit)\b/i.test(seg)) return true;
        break;
      }
      if (inStr) { if (ch === '\\') { i++; continue; } if (ch === strChar) inStr = false; continue; }
      if (ch === "'" || ch === '"') { inStr = true; strChar = ch; continue; }
      if (ch === '(' || ch === '[') { depth++; continue; }
      if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); continue; }
      if (ch === '|' && depth === 0) {
        const seg = line.slice(start, i).trim();
        if (/^(take|top|limit)\b/i.test(seg)) return true;
        start = i + 1;
      }
    }
  }
  return false;
}

// Splits a KQL expression by top-level 'and'/'or' operators. String-literal-aware — an 'and'/'or'
// substring (or a paren) inside a quoted value is inert, and a backslash-escaped quote (esc()'s own
// escaping model) does not end the string.
function splitTopLevelOps(expr: string): Array<{ part: string; join: 'and' | 'or' | null }> {
  const result: Array<{ part: string; join: 'and' | 'or' | null }> = [];
  let depth = 0, start = 0, inStr = false, strChar = '';
  let pendingJoin: 'and' | 'or' | null = null;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i] as string;
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = true; strChar = ch; continue; }
    if (ch === '(' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === ']') { depth--; continue; }
    if (depth !== 0) continue;

    const rest = expr.slice(i).toLowerCase();
    if (rest.startsWith('and ') || rest.startsWith('and\n')) {
      result.push({ part: expr.slice(start, i).trim(), join: pendingJoin });
      pendingJoin = 'and'; start = i + 4; i += 3;
    } else if (rest.startsWith('or ') || rest.startsWith('or\n')) {
      result.push({ part: expr.slice(start, i).trim(), join: pendingJoin });
      pendingJoin = 'or'; start = i + 3; i += 2;
    }
  }
  result.push({ part: expr.slice(start).trim(), join: pendingJoin });
  return result.filter(x => x.part);
}

/**
 * Removes parentheses that wrap an entire expression — `(A and B)` → `A and B` — repeatedly, so
 * `((A and B))` unwraps too.
 *
 * Only strips when the opening paren's match is the final character: `(A or B) and C` must be left
 * alone, since its parens group a part rather than the whole. Without this, a `| where` clause that
 * the generator emitted as one parenthesised group parses to zero conditions, and regenerating then
 * drops the clause entirely — turning a rule that matched a few resources into one that matches
 * every resource. Cheap function, expensive bug.
 */
function stripOuterParens(expr: string): string {
  let s = expr.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let spansWhole = true;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      // Depth hitting zero before the end means this opening paren closed early, so the parens
      // group a sub-expression and are load-bearing.
      if (depth === 0 && i < s.length - 1) { spansWhole = false; break; }
    }
    if (!spansWhole || depth !== 0) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Returns the inside of an expression that is entirely wrapped in one pair of parentheses, or null
 * when the parens are load-bearing (`(A or B) and C`) or absent. Lets a caller tell "this whole part
 * is a sub-expression to recurse into" apart from "this is a single condition".
 */
function parenthesisedInner(expr: string): string | null {
  const trimmed = expr.trim();
  const stripped = stripOuterParens(trimmed);
  return stripped === trimmed ? null : stripped;
}

// Strips one matching pair of outer quotes (if present) and unescapes esc()'s backslash-escaping.
function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0], last = t[t.length - 1];
    if ((first === "'" || first === '"') && last === first) {
      return t.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  return t;
}

// Splits a value list on top-level commas — string-literal-aware, so a quoted value containing a
// comma (or a bracket/paren) is not split apart. A backslash-escaped quote does not end the string.
function splitQ(csv: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0, inStr = false, strChar = '';
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i] as string;
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = true; strChar = ch; continue; }
    if (ch === '(' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); continue; }
    if (ch === ',' && depth === 0) {
      parts.push(csv.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(csv.slice(start).trim());
  return parts.map(stripOuterQuotes);
}

// ── Rule → violation KQL (buildRuleQuery) ─────────────────────────────────────

const FLIP_OP: Record<ConditionOperator, ConditionOperator> = {
  exists: 'notExists', notExists: 'exists',
  equals: 'notEquals', notEquals: 'equals',
  in: 'notIn', notIn: 'in',
  contains: 'notContains', notContains: 'contains',
  startsWith: 'startsWith', endsWith: 'endsWith', matches: 'matches',
};

// De Morgan's law: negating a joined pair of conditions also flips the join between them
// ("not (A and B)" == "not A or not B", never "not A and not B"). Each condition below is
// already individually negated (conditionToViolationKql) — this is the join that connects
// those negated parts, not the join stored on the (still compliant-state) source condition.
const FLIP_JOIN: Record<'and' | 'or', 'and' | 'or'> = { and: 'or', or: 'and' };

function conditionToViolationKql(cond: Condition): string | null {
  const flipped = FLIP_OP[cond.operator];
  if (flipped === cond.operator) {
    const inner = conditionToKql(cond);
    return inner ? `not (${inner})` : null;
  }
  return conditionToKql({ ...cond, operator: flipped });
}

function buildConditionGroupExpr(group: ConditionGroup): string | null {
  const parts: string[] = [];
  for (const cond of group.conditions) {
    const expr = conditionToViolationKql(cond);
    if (!expr) continue;
    parts.push(parts.length === 0 ? expr : `${FLIP_JOIN[cond.join ?? 'and']} ${expr}`);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;
  return `(${parts.join(' ')})`;
}

export function buildRuleQuery(rule: Rule): string {
  const lines: string[] = [scopeToTable(rule.scope.level)];

  if (!rule.resourceTypes.includes('*')) {
    const types = rule.resourceTypes.map(t => `'${esc(t.toLowerCase())}'`).join(', ');
    lines.push(`| where type in~ (${types})`);
  }

  // A flat rule.conditions list (no conditionGroups) is just a single-group shorthand — route it
  // through the same compiler so it gets the same De Morgan join-flip instead of a second,
  // separately-maintained (and previously buggy: always plain 'and') join implementation.
  const groups = rule.conditionGroups?.length ? rule.conditionGroups : [{ id: '', conditions: rule.conditions }];
  const parts: string[] = [];
  for (const group of groups) {
    const expr = buildConditionGroupExpr(group);
    if (!expr) continue;
    parts.push(parts.length === 0 ? expr : `${group.join ?? 'or'} ${expr}`);
  }
  if (parts.length > 0) lines.push(`| where ${parts.join('\n    ')}`);

  const cols = rule.projectColumns?.length ? rule.projectColumns : DEFAULT_PROJECT_COLUMNS;
  lines.push(`| project ${cols.join(', ')}`);
  return lines.join('\n');
}

export function conditionToKql(condition: Condition): string | null {
  const field = fieldToKqlExpr(condition.field);
  if (!field) return null;
  const val = esc(condition.value ?? '');

  switch (condition.operator) {
    case 'exists':      return `isnotempty(tostring(${field}))`;
    case 'notExists':   return `isempty(tostring(${field}))`;
    case 'equals':      return `${field} =~ '${val}'`;
    case 'notEquals':   return `${field} !~ '${val}'`;
    case 'in': {
      const list = (condition.values ?? []).map(v => `'${esc(v)}'`).join(', ');
      return `${field} in~ (${list})`;
    }
    case 'notIn': {
      const list = (condition.values ?? []).map(v => `'${esc(v)}'`).join(', ');
      return `not (${field} in~ (${list}))`;
    }
    case 'contains':    return `${field} contains '${val}'`;
    case 'notContains': return `not (${field} contains '${val}')`;
    case 'startsWith':  return `${field} startswith '${val}'`;
    case 'endsWith':    return `${field} endswith '${val}'`;
    case 'matches':     return `${field} matches regex '${val}'`;
    default:            return null;
  }
}

// ── Visual Query Builder — KQL generation ────────────────────────────────────

function computeColExpr(c: ComputedColumn): string {
  if (c.exprType === 'raw')      return c.rawExpr?.trim() ?? '';
  if (c.exprType === 'field')    return c.field?.trim() ?? '';
  if (c.exprType === 'function' && c.fnName) {
    return `${c.fnName}(${(c.fnArgs ?? []).join(', ')})`;
  }
  return '';
}

function visualConditionToKql(c: VisualFilterCondition): string | null {
  // A passthrough condition has no field or operator of its own — it is the user's own KQL, and goes
  // back out exactly as it came in.
  if (c.operator === 'raw') return c.rawExpr?.trim() || null;

  const f = fieldToKqlExpr(c.field);
  if (!f) return null;
  const val  = esc(c.value ?? '');
  const num  = c.value ?? '0';
  const num2 = c.value2 ?? c.value ?? '0';
  const vals = (c.values ?? []).map(v => `'${esc(v)}'`).join(', ');

  switch (c.operator) {
    case 'exists':         return `isnotempty(tostring(${f}))`;
    case 'notExists':      return `isempty(tostring(${f}))`;
    case 'isNull':         return `isnull(${f})`;
    case 'isNotNull':      return `isnotnull(${f})`;
    case 'isEmpty':        return `isempty(tostring(${f}))`;
    case 'isNotEmpty':     return `isnotempty(tostring(${f}))`;
    case 'isTrue':         return `${f} == true`;
    case 'isFalse':        return `${f} == false`;
    case 'equals':         return `${f} =~ '${val}'`;
    case 'notEquals':      return `${f} !~ '${val}'`;
    case 'contains':       return `${f} contains '${val}'`;
    case 'notContains':    return `${f} !contains '${val}'`;
    case 'startsWith':     return `${f} startswith '${val}'`;
    case 'notStartsWith':  return `not (${f} startswith '${val}')`;
    case 'endsWith':       return `${f} endswith '${val}'`;
    case 'notEndsWith':    return `not (${f} endswith '${val}')`;
    case 'matchesRegex':   return `${f} matches regex '${val}'`;
    case 'has':            return `${f} has '${val}'`;
    case 'notHas':         return `${f} !has '${val}'`;
    case 'hasAny':         return vals ? `${f} has_any (${vals})` : null;
    case 'gt':             return `tolong(${f}) > ${num}`;
    case 'gte':            return `tolong(${f}) >= ${num}`;
    case 'lt':             return `tolong(${f}) < ${num}`;
    case 'lte':            return `tolong(${f}) <= ${num}`;
    case 'between':        return `tolong(${f}) >= ${num} and tolong(${f}) <= ${num2}`;
    case 'olderThanDays':  return `todatetime(${f}) < ago(${num}d)`;
    case 'withinLastDays': return `todatetime(${f}) > ago(${num}d)`;
    case 'arrayEmpty':     return `(isnull(${f}) or array_length(${f}) == 0)`;
    case 'arrayNotEmpty':  return `(isnotnull(${f}) and array_length(${f}) > 0)`;
    case 'arrayLengthGt':  return `array_length(${f}) > ${num}`;
    case 'arrayLengthLte': return `array_length(${f}) <= ${num}`;
    case 'arrayContains':  return `${f} contains '${val}'`;
    case 'in':             return vals ? `${f} in~ (${vals})` : null;
    case 'notIn':          return vals ? `${f} !in~ (${vals})` : null;
    default:               return null;
  }
}

function buildFilterGroupExpr(group: VisualFilterGroup): string | null {
  const parts: string[] = [];
  for (const cond of group.conditions) {
    const expr = visualConditionToKql(cond);
    if (!expr) continue;
    parts.push(parts.length === 0 ? expr : `${cond.join ?? 'and'} ${expr}`);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;
  return `(${parts.join(' ')})`;
}

function buildFilterStageKql(stage: FilterStage): string | null {
  const groupParts: string[] = [];
  for (const group of stage.groups) {
    const expr = buildFilterGroupExpr(group);
    if (!expr) continue;
    groupParts.push(groupParts.length === 0 ? expr : `${group.join ?? 'or'} ${expr}`);
  }
  return groupParts.length > 0 ? groupParts.join('\n    ') : null;
}

// RB-RM-004: a condition can look filled in (a field selected, values typed) and still compile to
// null — an unwritable field, or hasAny/in/notIn with an empty value list. Checking real compilation
// here, the same path buildQueryFromVisual uses, is what catches that; checking field non-emptiness
// (the old isRealCondition) does not.
export function hasCompilableFilter(vq: VisualQuery): boolean {
  return vq.stages.some(stage => stage.type === 'filter' && buildFilterStageKql(stage) !== null);
}

// Shared by buildQueryFromVisual and buildPopulationQuery: scope table, resource-type filter, and
// every stage of the pipeline (filter/compute/expand/aggregate/join/sort/limit/shape/raw). The two
// callers differ only in the terminal stage they append (`| project <cols>` vs `| count`).
function buildVisualQueryLines(
  vq: VisualQuery,
  rule: Pick<Rule, 'scope' | 'resourceTypes'>,
): string[] {
  const lines: string[] = [scopeToTable(rule.scope.level)];

  if (!rule.resourceTypes.includes('*')) {
    const types = rule.resourceTypes.map(t => `'${esc(t.toLowerCase())}'`).join(', ');
    lines.push(`| where type in~ (${types})`);
  }

  for (const stage of vq.stages) {
    switch (stage.type) {
      case 'filter': {
        const clause = buildFilterStageKql(stage);
        if (clause) lines.push(`| where ${clause}`);
        break;
      }
      case 'compute': {
        const cols = stage.columns
          .filter(c => c.alias.trim() && computeColExpr(c))
          .map(c => `${c.alias.trim()} = ${computeColExpr(c)}`)
          .join(', ');
        if (cols) lines.push(`| extend ${cols}`);
        break;
      }
      case 'expand': {
        if (stage.field.trim()) {
          const expr = stage.alias?.trim()
            ? `${stage.alias.trim()} = ${stage.field.trim()}`
            : stage.field.trim();
          lines.push(`| mv-expand ${expr}`);
        }
        break;
      }
      case 'aggregate': {
        const aggs = stage.columns
          .filter(c => c.alias.trim() && c.fn)
          .map(c => {
            const field = c.field?.trim() ?? '';
            if (c.fn === 'count') return `${c.alias.trim()} = count()`;
            if (c.fn === 'countif') return `${c.alias.trim()} = countif(${c.condition?.trim() ?? 'true'})`;
            if (!field) return null;
            return `${c.alias.trim()} = ${c.fn}(${field})`;
          })
          .filter((s): s is string => s !== null)
          .join(', ');
        const by = stage.groupBy.filter(f => f.trim()).map(f => f.trim()).join(', ');
        if (aggs) lines.push(`| summarize ${aggs}${by ? ` by ${by}` : ''}`);
        else if (by) lines.push(`| summarize by ${by}`); // bare group-by (distinct rows)
        break;
      }
      case 'join': {
        if (stage.rightQuery.trim()) {
          const indented = stage.rightQuery.trim().split('\n').map(l => `    ${l}`).join('\n');
          const onExpr = stage.onLeft === stage.onRight
            ? stage.onLeft
            : `$left.${stage.onLeft} == $right.${stage.onRight}`;
          lines.push(`| join kind=${stage.kind} (\n${indented}\n) on ${onExpr}`);
        }
        break;
      }
      case 'sort': {
        const cols = stage.columns
          .filter(c => c.field.trim())
          .map(c => `${c.field.trim()} ${c.direction}`)
          .join(', ');
        if (cols) lines.push(`| order by ${cols}`);
        break;
      }
      case 'limit': {
        if (stage.count > 0) {
          if (stage.mode === 'top' && stage.orderBy?.field.trim()) {
            lines.push(`| top ${stage.count} by ${stage.orderBy.field.trim()} ${stage.orderBy.direction}`);
          } else {
            lines.push(`| take ${stage.count}`);
          }
        }
        break;
      }
      case 'shape': {
        const cols = stage.columns.filter(c => c.trim()).join(', ');
        if (cols) lines.push(`| ${stage.mode} ${cols}`);
        break;
      }
      case 'raw': {
        if (stage.clause.trim()) lines.push(`| ${stage.clause}`);
        break;
      }
    }
  }

  return lines;
}

export function buildQueryFromVisual(
  vq: VisualQuery,
  rule: Pick<Rule, 'scope' | 'resourceTypes' | 'projectColumns'>,
): string {
  const lines = buildVisualQueryLines(vq, rule);
  const outCols = rule.projectColumns?.length ? rule.projectColumns : DEFAULT_PROJECT_COLUMNS;
  lines.push(`| project ${outCols.join(', ')}`);
  return lines.join('\n');
}

// Applies-to population/count query (spec 031) — the same condition-group compiler, scope, and
// resource-type handling as buildQueryFromVisual, but terminating in `| count` instead of
// `| project <columns>`. Used as the denominator for a rule's "X of Y affected" display.
export function buildPopulationQuery(
  vq: VisualQuery,
  rule: Pick<Rule, 'scope' | 'resourceTypes'>,
): string {
  const lines = buildVisualQueryLines(vq, rule);
  lines.push('| count');
  return lines.join('\n');
}

// ── Visual Query Builder — KQL parser ────────────────────────────────────────

export interface ParsedVisualResult {
  visualQuery: VisualQuery;
  scope: { level: RuleScope['level']; subscriptions?: string[]; managementGroups?: string[] };
  resourceTypes: string[];
  projectColumns: string[];
  warnings: string[];
}

function defaultFilterStage(): FilterStage {
  return {
    id: uid(), type: 'filter',
    groups: [{ id: uid(), conditions: [{ id: uid(), field: '', operator: 'notExists' }] }],
  };
}

export function parseKqlToVisualQuery(kql: string): ParsedVisualResult {
  const result: ParsedVisualResult = {
    visualQuery: { stages: [] },
    scope: { level: 'resource' },
    resourceTypes: [],
    projectColumns: [],
    warnings: [],
  };

  const rawLines = kql
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);

  if (rawLines.length === 0) {
    result.visualQuery.stages.push(defaultFilterStage());
    return result;
  }

  // A leading bare '(' wraps the entire first branch of a top-level `| union (...)` in a pure
  // grouping paren (e.g. `( resources | where ... | project ... ) | union ( ... )`, RB-QA-008b /
  // spec 027). KQL's pipe already scopes "everything piped before it" as the union's left branch,
  // parenthesized or not, so `(A) | union (B)` and `A | union (B)` are semantically identical —
  // dropping the wrap is lossless. Without this, the wrap's own line is mistaken for the table line
  // (scope detection silently falls back to the default) and its matching close gets glued onto the
  // last real clause as corrupted text.
  const leadingWrapped = rawLines[0] === '(';
  const bodyLinesRaw = leadingWrapped ? rawLines.slice(1) : rawLines;

  if (bodyLinesRaw.length === 0) {
    result.visualQuery.stages.push(defaultFilterStage());
    return result;
  }

  // A body that opens directly with a top-level `|` (e.g. a pasted `| where ...` snippet with no
  // table name) has no table line at all. Without this, splitTopLevelPipes' `.filter(Boolean)`
  // drops the resulting leading empty segment and the where-clause text itself gets mistaken for
  // the table name below, silently losing the whole clause to defaultFilterStage() (spec 043).
  // Prepending 'Resources' — the same default RuleScope.level:'resource' already assumes — makes
  // this take the exact same path a real `Resources\n| where ...` input would, so scope/clause
  // handling can't diverge from the working case. The user is told, since this is a repair, not a
  // literal read of what they typed.
  const bareLeadingPipe = /^\s*\|/.test(bodyLinesRaw[0] as string);
  if (bareLeadingPipe) {
    result.warnings.push('No table name found before the first "|" — assumed "Resources".');
  }
  const bodyLines = bareLeadingPipe ? ['Resources', ...bodyLinesRaw] : bodyLinesRaw;

  if (bodyLines.length === 0) {
    result.visualQuery.stages.push(defaultFilterStage());
    return result;
  }

  // First line: table, plus any clauses written inline after it. The generator itself emits the
  // three container scopes that way (`ResourceContainers | where type =~ '...'`), and pasted Portal
  // queries often put the first filter on the table line too — so a parser that only reads clauses
  // from line two down cannot see the clause that *defines the scope*, and regenerating then reverts
  // the rule to `Resources`, silently changing what it scans.
  const firstLine = bodyLines[0] as string;
  const inlineParts = splitTopLevelPipes(firstLine);
  const tableExpr = inlineParts[0] as string;
  if (/^Resources$/i.test(tableExpr))             result.scope.level = 'resource';
  else if (/^ResourceContainers/i.test(tableExpr)) { /* refined by the type marker clause below */ }

  // Collect multi-line clauses: lines starting with '|' begin a new clause;
  // other lines are continuation. Track paren depth so that '|' lines inside
  // a join subquery (| join kind=X (...)) are treated as continuation, not new
  // top-level clauses.
  const clauseStrings: string[] = inlineParts.slice(1);
  // Seed depth from whatever was already opened *inline* on the first line (e.g. the `(` in
  // `Resources | union (`) — the loop below only scans bodyLines[1..], so without this seed a
  // first-line-inline opener is invisible to it and every line inside that subquery gets walked one
  // paren short of reality (RB-QA-008c / spec 028). Uses the exact same quote-aware `(`/`)`-only
  // counting rule the loop applies per line, so the seed can't diverge from what the loop counts.
  // For every existing shape this is 0 (a bare table name, or an inline clause that opens and closes
  // on the same line), so behavior is unchanged except when the first line ends with an unmatched
  // open paren.
  let parenDepth = 0;
  {
    let inStr = false, strChar = '';
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i] as string;
      if (inStr) { if (ch === '\\') { i++; continue; } if (ch === strChar) inStr = false; continue; }
      if (ch === "'" || ch === '"') { inStr = true; strChar = ch; }
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  // Set only when the leading wrap was sliced off above; consumed (and never rechecked) the first
  // time we see that wrap's own matching close, so this never generalizes into a rule about bare
  // `)` lines from any other cause — a first-line-inline `Resources | union (` (leadingWrapped
  // false) is completely unaffected.
  let wrapPendingClose = leadingWrapped;
  for (let i = 1; i < bodyLines.length; i++) {
    const raw = bodyLines[i] as string;
    // Use depth BEFORE this line to decide if it's a new top-level clause.
    const depthBefore = parenDepth;
    // Update depth based on unquoted parens in this line.
    let inStr = false, strChar = '';
    for (let ci2 = 0; ci2 < raw.length; ci2++) {
      const ch = raw[ci2] as string;
      if (inStr) { if (ch === '\\') { ci2++; continue; } if (ch === strChar) inStr = false; continue; }
      if (ch === "'" || ch === '"') { inStr = true; strChar = ch; }
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    }
    if (wrapPendingClose && depthBefore === 0 && raw === ')') {
      wrapPendingClose = false;
      continue;
    }
    const pipeM = raw.match(/^\s*\|\s*(.+)$/);
    if (pipeM && depthBefore === 0) {
      clauseStrings.push((pipeM[1] ?? '').trim());
    } else if (clauseStrings.length > 0) {
      clauseStrings[clauseStrings.length - 1] += '\n' + raw;
    }
  }

  // Find the last | project clause — that's output columns, not a ShapeStage. Only the clause that
  // is truly the final one in the pipeline qualifies: a `project` that appears earlier (e.g.
  // immediately before a `union`) is real mid-pipeline shaping, not output metadata, and the
  // generator always re-emits "the" output project last — extracting a non-trailing one would
  // silently move it past whatever comes after it, changing what that later clause receives.
  let lastProjectIdx = -1;
  if (clauseStrings.length > 0) {
    const lastClause = clauseStrings[clauseStrings.length - 1] as string;
    if (/^project\b/i.test(lastClause) && !/^project-away\b/i.test(lastClause)) {
      lastProjectIdx = clauseStrings.length - 1;
    }
  }

  for (let ci = 0; ci < clauseStrings.length; ci++) {
    const clause = clauseStrings[ci] as string;

    // | project (output columns vs mid-pipeline ShapeStage)
    if (/^project\b/i.test(clause) && !/^project-away\b/i.test(clause)) {
      const cols = clause.replace(/^project\s+/i, '').trim()
        .split(',').map(c => c.trim()).filter(Boolean);
      if (ci === lastProjectIdx) {
        result.projectColumns = cols;
      } else {
        result.visualQuery.stages.push({ id: uid(), type: 'shape', mode: 'project', columns: cols });
      }
      continue;
    }

    // | project-away
    if (/^project-away\b/i.test(clause)) {
      const cols = clause.replace(/^project-away\s+/i, '').trim()
        .split(',').map(c => c.trim()).filter(Boolean);
      result.visualQuery.stages.push({ id: uid(), type: 'shape', mode: 'project-away', columns: cols });
      continue;
    }

    // | take N
    if (/^take\b/i.test(clause)) {
      const n = parseInt(clause.replace(/^take\s+/i, '').trim(), 10);
      if (!isNaN(n) && n > 0) result.visualQuery.stages.push({ id: uid(), type: 'limit', mode: 'take', count: n });
      continue;
    }

    // | top N by field [asc|desc]
    if (/^top\b/i.test(clause)) {
      const m = clause.match(/^top\s+(\d+)(?:\s+by\s+(.+?)(?:\s+(asc|desc))?)?$/i);
      if (m) {
        result.visualQuery.stages.push({
          id: uid(), type: 'limit', mode: 'top',
          count: parseInt(m[1] as string, 10),
          orderBy: m[2] ? { field: (m[2] as string).trim(), direction: (((m[3] ?? 'asc') as string).toLowerCase() as 'asc' | 'desc') } : undefined,
        });
      }
      continue;
    }

    // | order by ...
    if (/^order\s+by\b/i.test(clause)) {
      const colStr = clause.replace(/^order\s+by\s+/i, '').trim();
      const cols = splitTopLevelCommas(colStr).map(s => {
        const m = s.trim().match(/^(.+?)\s+(asc|desc)$/i);
        return { field: m?.[1]?.trim() ?? s.trim(), direction: ((m?.[2]?.toLowerCase() ?? 'asc') as 'asc' | 'desc') };
      }).filter(c => c.field);
      if (cols.length) result.visualQuery.stages.push({ id: uid(), type: 'sort', columns: cols });
      continue;
    }

    // | extend ...
    if (/^extend\b/i.test(clause)) {
      const stage = parseExtendClause(clause.replace(/^extend\s+/i, '').trim());
      if (stage) result.visualQuery.stages.push(stage);
      continue;
    }

    // | mv-expand [alias =] field  (mvexpand is the legacy Kusto alias, sometimes with no space: mvexpand(field))
    if (/^mv-?expand\b/i.test(clause)) {
      let rest = clause.replace(/^mv-?expand\s*/i, '').trim();
      const parenM = rest.match(/^\(\s*([\s\S]+?)\s*\)$/);
      if (parenM) rest = (parenM[1] ?? '').trim();
      const aliasM = rest.match(/^(\w+)\s*=\s*(.+)$/);
      result.visualQuery.stages.push({
        id: uid(), type: 'expand',
        alias: aliasM?.[1],
        field: (aliasM?.[2]?.trim() ?? rest).trim(),
      });
      continue;
    }

    // | summarize ...
    if (/^summarize\b/i.test(clause)) {
      const stage = parseSummarizeClause(clause.replace(/^summarize\s+/i, '').trim());
      if (stage) result.visualQuery.stages.push(stage);
      else result.warnings.push(`Could not parse summarize: ${clause.slice(0, 60)}`);
      continue;
    }

    // | join ...
    if (/^join\b/i.test(clause)) {
      const stage = parseJoinClause(clause);
      if (stage) result.visualQuery.stages.push(stage);
      else result.warnings.push(`Could not parse join: ${clause.slice(0, 80)}`);
      continue;
    }

    // | where ...
    if (/^where\s+/i.test(clause)) {
      const stage = parseWhereToVisualStage(clause.replace(/^where\s+/i, '').trim(), result);
      if (stage) result.visualQuery.stages.push(stage);
      continue;
    }

    // | limit N — a documented ARG/Kusto alias of | take N, same semantics. Parsed into the same
    // LimitStage rather than dropped, so a rule authored with `limit` keeps its cap; regenerating
    // canonicalizes it to `take` (the form the builder always emits), which is the accepted aliasing
    // behavior for two operators that compile to byte-identical output, not a round-trip loss.
    if (/^limit\b/i.test(clause)) {
      const n = parseInt(clause.replace(/^limit\s+/i, '').trim(), 10);
      if (!isNaN(n) && n > 0) result.visualQuery.stages.push({ id: uid(), type: 'limit', mode: 'take', count: n });
      continue;
    }

    // | union (...) — carried through verbatim as a read-only block rather than dropped. Scoped to
    // this one keyword deliberately: a general unrecognized-clause fallback has real interactions
    // with the project-as-output-metadata extraction above that are only verified for this shape.
    if (/^union\b/i.test(clause)) {
      result.visualQuery.stages.push({ id: uid(), type: 'raw', clause });
      continue;
    }

    result.warnings.push(`Unsupported pipe: | ${clause.slice(0, 60)}`);
  }

  if (result.visualQuery.stages.length === 0) {
    result.visualQuery.stages.push(defaultFilterStage());
  }
  return result;
}

// ── parse helpers ─────────────────────────────────────────────────────────────

function parseExtendClause(rest: string): ComputeStage | null {
  const parts = splitTopLevelCommas(rest);
  const columns: ComputedColumn[] = [];
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    const alias = part.slice(0, eqIdx).trim();
    const expr  = part.slice(eqIdx + 1).trim();
    if (!alias || !expr) continue;
    // Detect function call: name(args)
    const fnM = expr.match(/^(\w+)\(([\s\S]*)\)$/);
    if (fnM && fnM[1]) {
      const fnArgs = (fnM[2] ?? '') ? splitTopLevelCommas(fnM[2] ?? '') : [];
      columns.push({ id: uid(), alias, exprType: 'function', fnName: fnM[1], fnArgs });
    } else if (/^[\w.[\]'"]+$/.test(expr.replace(/\s/g, ''))) {
      columns.push({ id: uid(), alias, exprType: 'field', field: expr });
    } else {
      columns.push({ id: uid(), alias, exprType: 'raw', rawExpr: expr });
    }
  }
  return columns.length > 0 ? { id: uid(), type: 'compute', columns } : null;
}

function parseSummarizeClause(rest: string): AggregateStage | null {
  // Bare group-by shorthand: `summarize by a, b` (no aggregation columns)
  const bareByM = rest.match(/^by\s+([\s\S]+)$/i);
  if (bareByM) {
    const groupBy = splitTopLevelCommas(bareByM[1] ?? '').map(f => f.trim()).filter(Boolean);
    return groupBy.length ? { id: uid(), type: 'aggregate', columns: [], groupBy } : null;
  }
  // Find top-level ' by ' to separate aggregations from group-by
  let byIdx = -1, depth = 0;
  const lower = rest.toLowerCase();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '(') depth++;
    else if (rest[i] === ')') depth--;
    else if (depth === 0 && lower.slice(i).startsWith(' by ')) { byIdx = i; break; }
  }

  const aggPart = byIdx >= 0 ? rest.slice(0, byIdx).trim() : rest;
  const byPart  = byIdx >= 0 ? rest.slice(byIdx + 4).trim() : '';

  const columns: AggregateColumn[] = [];
  for (const part of splitTopLevelCommas(aggPart)) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    const alias  = part.slice(0, eqIdx).trim();
    const fnExpr = part.slice(eqIdx + 1).trim();
    const fnM = fnExpr.match(/^(\w+)\(([\s\S]*)\)$/);
    if (!fnM || !alias) continue;
    const fnName = fnM[1]!.toLowerCase() as AggFn;
    const fnArg  = (fnM[2] ?? '').trim();
    columns.push({
      id: uid(), alias, fn: fnName,
      field: (fnName !== 'count' && fnName !== 'countif') ? fnArg || undefined : undefined,
      condition: fnName === 'countif' ? fnArg || undefined : undefined,
    });
  }

  const groupBy = byPart ? splitTopLevelCommas(byPart).map(f => f.trim()).filter(Boolean) : [];
  if (columns.length === 0 && groupBy.length === 0) return null;
  return { id: uid(), type: 'aggregate', columns, groupBy };
}

function parseJoinClause(clause: string): JoinStage | null {
  const kindM = clause.match(/^join\s+kind=(\w+)/i);
  const kind  = ((kindM?.[1] ?? 'inner').toLowerCase()) as JoinKind;

  const parenStart = clause.indexOf('(');
  if (parenStart < 0) return null;

  let depth = 0, parenEnd = -1;
  for (let i = parenStart; i < clause.length; i++) {
    if (clause[i] === '(') depth++;
    else if (clause[i] === ')') { depth--; if (depth === 0) { parenEnd = i; break; } }
  }
  if (parenEnd < 0) return null;

  const rightQuery = clause.slice(parenStart + 1, parenEnd).trim();
  const onPart    = clause.slice(parenEnd + 1).trim().replace(/^on\s+/i, '').trim();

  const dollarM = onPart.match(/^\$left\.(\w+)\s*==\s*\$right\.(\w+)$/i);
  const simpleM = onPart.match(/^(\w+)$/);

  return {
    id: uid(), type: 'join', kind, rightQuery,
    onLeft:  dollarM?.[1] ?? simpleM?.[1] ?? onPart,
    onRight: dollarM?.[2] ?? simpleM?.[1] ?? onPart,
  };
}

// Finds the index of the next unescaped occurrence of `quoteChar` at or after `from`, treating a
// backslash-escaped quote (esc()'s own escaping model) as inert rather than a terminator. Returns
// -1 when no unescaped closing quote exists.
function findClosingQuote(expr: string, from: number, quoteChar: string): number {
  let i = from;
  while (i < expr.length) {
    if (expr[i] === '\\') { i += 2; continue; }
    if (expr[i] === quoteChar) return i;
    i++;
  }
  return -1;
}

// Normalize hand-written KQL forms so the condition regexes (which expect
// single-quoted strings and != ) can match: "..." → '...', <> → !=.
// String-aware single pass — content inside existing '...' literals is untouched. Escape-aware
// (RB-RM-006/spec 040): a backslash-escaped quote inside the literal does not end it early, which
// matters because that early end would otherwise make a later real quote in the expression look like
// a fresh string open, swallowing whatever comes between them — including a real top-level and/or.
function normalizeKqlExpr(expr: string): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'") {
      const end = findClosingQuote(expr, i + 1, "'");
      if (end < 0) { out += expr.slice(i); break; }
      out += expr.slice(i, end + 1); i = end + 1; continue;
    }
    if (ch === '"') {
      const end = findClosingQuote(expr, i + 1, '"');
      if (end < 0) { out += expr.slice(i); break; }
      out += `'${expr.slice(i + 1, end)}'`; i = end + 1; continue;
    }
    if (ch === '<' && expr[i + 1] === '>') { out += '!='; i += 2; continue; }
    out += ch; i++;
  }
  return out;
}

// `type` may be written bare or as bracket notation ['type']
const TYPE_FIELD = String.raw`(?:\['type'\]|type)`;
const TYPE_EQ_RE  = new RegExp(String.raw`^${TYPE_FIELD}\s*(?:=~|==)\s*'([^']+)'`, 'i');
const TYPE_IN_RE  = new RegExp(String.raw`^${TYPE_FIELD}\s+in~?\s*\(([\s\S]+?)\)`, 'i');

/**
 * `arrayEmpty` and `arrayNotEmpty` are the only operators whose generated KQL is itself a
 * parenthesised compound expression, so a rule using one of them reads like two conditions joined by
 * `or`/`and`. Matched as one unit — and only when both halves name the same field, since otherwise it
 * genuinely is two conditions. Splitting it instead regenerates a *narrower* rule than the author
 * wrote ("missing" rather than "missing or empty"), and the violations it stops reporting are
 * invisible.
 */
const ARRAY_EMPTY_RE     = /^\(\s*isnull\s*\(\s*(.+?)\s*\)\s+or\s+array_length\s*\(\s*(.+?)\s*\)\s*==\s*0\s*\)$/i;
const ARRAY_NOT_EMPTY_RE = /^\(\s*isnotnull\s*\(\s*(.+?)\s*\)\s+and\s+array_length\s*\(\s*(.+?)\s*\)\s*>\s*0\s*\)$/i;

function parseArrayCompositeExpr(expr: string): VisualFilterCondition | null {
  const shapes = [
    [ARRAY_EMPTY_RE, 'arrayEmpty'],
    [ARRAY_NOT_EMPTY_RE, 'arrayNotEmpty'],
  ] as const;
  for (const [re, operator] of shapes) {
    const m = expr.trim().match(re);
    if (!m) continue;
    const field = kqlToField(m[1] ?? '');
    if (field !== kqlToField(m[2] ?? '')) continue;
    return { id: uid(), field, operator };
  }
  return null;
}

/**
 * Turns one top-level part of a `| where` clause into either a condition appended to the group being
 * built, or a group of its own when the part is a parenthesised sub-expression. Returns the group the
 * next simple condition should join, or null when the caller must start a fresh one.
 */
function absorbFilterPart(
  part: string,
  join: 'and' | 'or' | null,
  groups: VisualFilterGroup[],
  current: VisualFilterGroup | null,
): VisualFilterGroup | null {
  const appendTo = (cond: VisualFilterCondition): VisualFilterGroup => {
    const group = current ?? { id: uid(), join: groups.length === 0 ? undefined : 'and', conditions: [] };
    if (!current) groups.push(group);
    cond.join = group.conditions.length === 0 ? undefined : (join ?? 'and');
    group.conditions.push(cond);
    return group;
  };

  const single = parseWritableCondition(part);
  if (single) return appendTo(single);

  // Not a single condition, so it may be a parenthesised group — `(A or B) and C`. Recursing into it
  // as its own group is what keeps the grouping; handing it to the single-condition matcher instead
  // silently dropped half the filter (RB-QA-004).
  const inner = parenthesisedInner(part);
  if (inner !== null) {
    const conditions = parseVisualConditionList(splitTopLevelOps(inner));
    if (conditions.length > 0) {
      groups.push({ id: uid(), join: groups.length === 0 ? undefined : (join ?? 'and'), conditions });
      return null;
    }
    return current;
  }

  // Neither a condition the builder knows nor a group — keep it verbatim as a passthrough.
  return appendTo(passthroughCondition(part, undefined));
}

function parseWhereToVisualStage(cond: string, result: ParsedVisualResult): FilterStage | null {
  cond = normalizeKqlExpr(cond);
  // ResourceContainers scope markers
  if (/^type\s*(?:=~|==)\s*'microsoft\.resources\/subscriptions\/resourcegroups'/i.test(cond)) {
    result.scope.level = 'resourceGroup'; return null;
  }
  if (/^type\s*(?:=~|==)\s*'microsoft\.resources\/subscriptions'/i.test(cond)) {
    result.scope.level = 'subscription'; return null;
  }
  if (/^type\s*(?:=~|==)\s*'microsoft\.management\/managementgroups'/i.test(cond)) {
    result.scope.level = 'managementGroup'; return null;
  }
  // Resource types
  const typeIn = cond.match(TYPE_IN_RE);
  if (typeIn) { result.resourceTypes = splitQ(typeIn[1] ?? ''); return null; }
  const typeEq = cond.match(TYPE_EQ_RE);
  if (typeEq) { result.resourceTypes = [typeEq[1] ?? '']; return null; }

  // A whole clause can be one condition that happens to compile to a compound expression. Checked
  // before the split below, because splitting it is what loses half of it.
  const composite = parseArrayCompositeExpr(cond);
  if (composite) {
    return { id: uid(), type: 'filter', groups: [{ id: uid(), conditions: [composite] }] };
  }

  // A clause the generator emitted as a single group arrives fully parenthesised. Unwrap before
  // splitting, or the whole thing reads as one unparseable part and the clause is lost.
  cond = stripOuterParens(cond);

  const ops   = splitTopLevelOps(cond);
  const hasOr = ops.some(x => x.join === 'or');
  const groups: VisualFilterGroup[] = [];

  if (hasOr) {
    // A top-level `or` makes each part its own group, so the builder shows the same grouping the KQL
    // has rather than flattening `A or (B and C)` into one row of conditions.
    for (let gi = 0; gi < ops.length; gi++) {
      const { part, join } = ops[gi] as { part: string; join: 'and' | 'or' | null };
      const groupJoin = gi === 0 ? undefined : (join ?? 'or') as 'and' | 'or';
      const single = parseWritableCondition(part);
      if (single) {
        groups.push({ id: uid(), join: groupJoin, conditions: [single] });
        continue;
      }
      const inner = parenthesisedInner(part) ?? part;
      const conditions = parseVisualConditionList(splitTopLevelOps(inner));
      if (conditions.length > 0) groups.push({ id: uid(), join: groupJoin, conditions });
    }
  } else {
    // Only `and` at the top level, so simple conditions accumulate into one group and any
    // parenthesised sub-expression becomes a group of its own beside them.
    let current: VisualFilterGroup | null = null;
    for (const { part, join } of ops) {
      current = absorbFilterPart(part, join, groups, current);
    }
  }

  if (groups.length === 0) return null;
  return { id: uid(), type: 'filter', groups };
}

/** Wraps an expression the builder can't express so it survives the round trip untouched. */
function passthroughCondition(expr: string, join: 'and' | 'or' | undefined): VisualFilterCondition {
  return { id: uid(), field: '', operator: 'raw', rawExpr: expr.trim(), join };
}

/**
 * Parses one condition, and accepts it only if the generator can write it back out again.
 *
 * Several regexes will happily match an expression whose *field* is itself an expression —
 * `array_length(replicaSets) < 2`, `isnull(['threshold'])` — but `fieldToKqlExpr` has no output for
 * those, so the condition parsed cleanly and then vanished at generation time. Parsing something the
 * generator cannot re-emit is indistinguishable from not parsing it, so it's treated the same way:
 * rejected here, and kept verbatim as a passthrough by the caller.
 */
function parseWritableCondition(expr: string): VisualFilterCondition | null {
  const cond = parseVisualConditionExpr(expr);
  if (!cond) return null;
  return visualConditionToKql(cond) ? cond : null;
}

function parseVisualConditionList(
  parts: Array<{ part: string; join: 'and' | 'or' | null }>,
): VisualFilterCondition[] {
  const conditions: VisualFilterCondition[] = [];
  for (const { part, join } of parts) {
    const j = conditions.length === 0 ? undefined : (join ?? 'and') as 'and' | 'or';
    const c = parseWritableCondition(part.trim());
    if (c) {
      c.join = j;
      conditions.push(c);
    } else {
      conditions.push(passthroughCondition(part, j));
    }
  }
  return conditions;
}

// A plain field path (dots, optional tags['x'] brackets) — no operators, functions, or literals.
const KQL_KEYWORDS = new Set(['true', 'false', 'and', 'or', 'not', 'null']);
function isBareFieldPath(s: string): boolean {
  return /^[A-Za-z_][\w.]*(?:\['[^']+'\])?$/.test(s) && !KQL_KEYWORDS.has(s.toLowerCase());
}

function parseVisualConditionExpr(expr: string): VisualFilterCondition | null {
  expr = expr.trim();

  // arrayEmpty / arrayNotEmpty — each generates one parenthesised compound expression.
  const arrayComposite = parseArrayCompositeExpr(expr);
  if (arrayComposite) return arrayComposite;
  // exists: isnotempty(tostring(f))
  const existsM = expr.match(/^isnotempty\s*\(\s*tostring\s*\(\s*(.+?)\s*\)\s*\)$/i);
  if (existsM) return { id: uid(), field: kqlToField(existsM[1] ?? ''), operator: 'exists' };
  // notExists: isempty(tostring(f))
  const notExM = expr.match(/^isempty\s*\(\s*tostring\s*\(\s*(.+?)\s*\)\s*\)$/i);
  if (notExM) return { id: uid(), field: kqlToField(notExM[1] ?? ''), operator: 'notExists' };
  // isNull
  const isNullM = expr.match(/^isnull\s*\(\s*(.+?)\s*\)$/i);
  if (isNullM) return { id: uid(), field: kqlToField(isNullM[1] ?? ''), operator: 'isNull' };
  // isNotNull
  const isNotNullM = expr.match(/^isnotnull\s*\(\s*(.+?)\s*\)$/i);
  if (isNotNullM) return { id: uid(), field: kqlToField(isNotNullM[1] ?? ''), operator: 'isNotNull' };
  // arrayEmpty / arrayNotEmpty via bare array_length comparison
  const arrEmptyM = expr.match(/^array_length\s*\(\s*(.+?)\s*\)\s*==\s*0$/i);
  if (arrEmptyM) return { id: uid(), field: kqlToField(arrEmptyM[1] ?? ''), operator: 'arrayEmpty' };
  const arrNotEmptyM = expr.match(/^array_length\s*\(\s*(.+?)\s*\)\s*(?:!=\s*0|>\s*0)$/i);
  if (arrNotEmptyM) return { id: uid(), field: kqlToField(arrNotEmptyM[1] ?? ''), operator: 'arrayNotEmpty' };
  // arrayLengthGt
  const arrGtM = expr.match(/^array_length\s*\(\s*(.+?)\s*\)\s*>\s*(\d+)$/i);
  if (arrGtM) return { id: uid(), field: kqlToField(arrGtM[1] ?? ''), operator: 'arrayLengthGt', value: arrGtM[2] };
  // arrayLengthLte
  const arrLteM = expr.match(/^array_length\s*\(\s*(.+?)\s*\)\s*<=\s*(\d+)$/i);
  if (arrLteM) return { id: uid(), field: kqlToField(arrLteM[1] ?? ''), operator: 'arrayLengthLte', value: arrLteM[2] };
  // olderThanDays
  const olderM = expr.match(/^todatetime\s*\(\s*(.+?)\s*\)\s*<\s*ago\s*\(\s*(\d+)d\s*\)$/i);
  if (olderM) return { id: uid(), field: kqlToField(olderM[1] ?? ''), operator: 'olderThanDays', value: olderM[2] };
  // withinLastDays
  const withinM = expr.match(/^todatetime\s*\(\s*(.+?)\s*\)\s*>\s*ago\s*\(\s*(\d+)d\s*\)$/i);
  if (withinM) return { id: uid(), field: kqlToField(withinM[1] ?? ''), operator: 'withinLastDays', value: withinM[2] };
  // bare datetime field vs ago() without todatetime() wrapper (hand-written KQL)
  const bareAgoLtM = expr.match(/^(.+?)\s*<\s*ago\s*\(\s*(\d+)d\s*\)$/i);
  if (bareAgoLtM) return { id: uid(), field: kqlToField(bareAgoLtM[1] ?? ''), operator: 'olderThanDays', value: bareAgoLtM[2] };
  const bareAgoGtM = expr.match(/^(.+?)\s*>\s*ago\s*\(\s*(\d+)d\s*\)$/i);
  if (bareAgoGtM) return { id: uid(), field: kqlToField(bareAgoGtM[1] ?? ''), operator: 'withinLastDays', value: bareAgoGtM[2] };
  // strlen(f) == 0 → isEmpty; strlen(f) > 0 / != 0 → isNotEmpty
  const strlenEmptyM = expr.match(/^strlen\s*\(\s*(.+?)\s*\)\s*==\s*0$/i);
  if (strlenEmptyM) return { id: uid(), field: kqlToField(strlenEmptyM[1] ?? ''), operator: 'isEmpty' };
  const strlenNotEmptyM = expr.match(/^strlen\s*\(\s*(.+?)\s*\)\s*(?:!=\s*0|>\s*0)$/i);
  if (strlenNotEmptyM) return { id: uid(), field: kqlToField(strlenNotEmptyM[1] ?? ''), operator: 'isNotEmpty' };
  // gt
  const gtM = expr.match(/^tolong\s*\(\s*(.+?)\s*\)\s*>\s*(-?\d+(?:\.\d+)?)$/i);
  if (gtM) return { id: uid(), field: kqlToField(gtM[1] ?? ''), operator: 'gt', value: gtM[2] };
  // gte
  const gteM = expr.match(/^tolong\s*\(\s*(.+?)\s*\)\s*>=\s*(-?\d+(?:\.\d+)?)$/i);
  if (gteM) return { id: uid(), field: kqlToField(gteM[1] ?? ''), operator: 'gte', value: gteM[2] };
  // lt
  const ltM = expr.match(/^tolong\s*\(\s*(.+?)\s*\)\s*<\s*(-?\d+(?:\.\d+)?)$/i);
  if (ltM) return { id: uid(), field: kqlToField(ltM[1] ?? ''), operator: 'lt', value: ltM[2] };
  // lte
  const lteM = expr.match(/^tolong\s*\(\s*(.+?)\s*\)\s*<=\s*(-?\d+(?:\.\d+)?)$/i);
  if (lteM) return { id: uid(), field: kqlToField(lteM[1] ?? ''), operator: 'lte', value: lteM[2] };
  // hasAny
  const hasAnyM = expr.match(/^(.+?)\s+has_any\s*\(([\s\S]+?)\)$/i);
  if (hasAnyM) return { id: uid(), field: kqlToField(hasAnyM[1] ?? ''), operator: 'hasAny', values: splitQ(hasAnyM[2] ?? '') };
  // notIn: !in~
  const notInDM = expr.match(/^(.+?)\s+!in~\s*\(([\s\S]+?)\)$/i);
  if (notInDM) return { id: uid(), field: kqlToField(notInDM[1] ?? ''), operator: 'notIn', values: splitQ(notInDM[2] ?? '') };
  // notContains: !contains
  const notContDM = expr.match(/^(.+?)\s+!contains\s+'([^']*)'$/i);
  if (notContDM) return { id: uid(), field: kqlToField(notContDM[1] ?? ''), operator: 'notContains', value: notContDM[2] };
  // notHas: !has
  const notHasM = expr.match(/^(.+?)\s+!has\s+'([^']*)'$/i);
  if (notHasM) return { id: uid(), field: kqlToField(notHasM[1] ?? ''), operator: 'notHas', value: notHasM[2] };
  // has (after has_any check)
  const hasM = expr.match(/^(.+?)\s+has\s+'([^']*)'$/i);
  if (hasM) return { id: uid(), field: kqlToField(hasM[1] ?? ''), operator: 'has', value: hasM[2] };
  // not(...) wrapper: notStartsWith, notEndsWith
  const notWrapM = expr.match(/^not\s*\(\s*([\s\S]+?)\s*\)$/);
  if (notWrapM) {
    const inner = (notWrapM[1] ?? '').trim();
    const swM = inner.match(/^(.+?)\s+startswith\s+'([^']*)'$/i);
    if (swM) return { id: uid(), field: kqlToField(swM[1] ?? ''), operator: 'notStartsWith', value: swM[2] };
    const ewM = inner.match(/^(.+?)\s+endswith\s+'([^']*)'$/i);
    if (ewM) return { id: uid(), field: kqlToField(ewM[1] ?? ''), operator: 'notEndsWith', value: ewM[2] };
    // not(field) — bare boolean field negation
    if (isBareFieldPath(inner)) return { id: uid(), field: kqlToField(inner), operator: 'isFalse' };
  }
  // boolean literals (unquoted): field == true / field != false → isTrue; field == false / field != true → isFalse
  const boolM = expr.match(/^(.+?)\s*(==|!=)\s*(true|false)$/i);
  if (boolM) {
    const positive = (boolM[2] === '==') === ((boolM[3] ?? '').toLowerCase() === 'true');
    return { id: uid(), field: kqlToField(boolM[1] ?? ''), operator: positive ? 'isTrue' : 'isFalse' };
  }
  // equals: field == 'value' or field =~ 'value'
  const eqDblM = expr.match(/^(.+?)\s*==\s*'([^']*)'$/);
  if (eqDblM) return { id: uid(), field: kqlToField(eqDblM[1] ?? ''), operator: 'equals', value: eqDblM[2] };
  const eqTilM = expr.match(/^(.+?)\s*=~\s*'([^']*)'$/);
  if (eqTilM) return { id: uid(), field: kqlToField(eqTilM[1] ?? ''), operator: 'equals', value: eqTilM[2] };
  // notEquals: field != 'value' or field !~ 'value'
  const neqBangM = expr.match(/^(.+?)\s*!=\s*'([^']*)'$/);
  if (neqBangM) return { id: uid(), field: kqlToField(neqBangM[1] ?? ''), operator: 'notEquals', value: neqBangM[2] };
  const neqTilM = expr.match(/^(.+?)\s*!~\s*'([^']*)'$/);
  if (neqTilM) return { id: uid(), field: kqlToField(neqTilM[1] ?? ''), operator: 'notEquals', value: neqTilM[2] };
  // in~ / !in (literal array)
  const inTilM = expr.match(/^(.+?)\s+in~\s*\(([\s\S]+?)\)$/i);
  if (inTilM) return { id: uid(), field: kqlToField(inTilM[1] ?? ''), operator: 'in', values: splitQ(inTilM[2] ?? '') };
  const notInBM = expr.match(/^not\s*\(\s*(.+?)\s+in~\s*\(([\s\S]+?)\)\s*\)$/i);
  if (notInBM) return { id: uid(), field: kqlToField(notInBM[1] ?? ''), operator: 'notIn', values: splitQ(notInBM[2] ?? '') };
  // case-sensitive in / !in (hand-written KQL; builder regenerates as in~ / !in~)
  const notInCsM = expr.match(/^(.+?)\s+!in\s*\(([\s\S]+?)\)$/i);
  if (notInCsM) return { id: uid(), field: kqlToField(notInCsM[1] ?? ''), operator: 'notIn', values: splitQ(notInCsM[2] ?? '') };
  const inCsM = expr.match(/^(.+?)\s+in\s*\(([\s\S]+?)\)$/i);
  if (inCsM) return { id: uid(), field: kqlToField(inCsM[1] ?? ''), operator: 'in', values: splitQ(inCsM[2] ?? '') };
  // startsWith / endsWith (positive, not inside not(...))
  const swM = expr.match(/^(.+?)\s+startswith\s+'([^']*)'$/i);
  if (swM) return { id: uid(), field: kqlToField(swM[1] ?? ''), operator: 'startsWith', value: swM[2] };
  const ewM = expr.match(/^(.+?)\s+endswith\s+'([^']*)'$/i);
  if (ewM) return { id: uid(), field: kqlToField(ewM[1] ?? ''), operator: 'endsWith', value: ewM[2] };
  // contains (positive, already have notContains above)
  const contM = expr.match(/^(.+?)\s+contains\s+'([^']*)'$/i);
  if (contM) return { id: uid(), field: kqlToField(contM[1] ?? ''), operator: 'contains', value: contM[2] };
  // matches regex
  const reM = expr.match(/^(.+?)\s+matches\s+regex\s+'([^']*)'$/i);
  if (reM) return { id: uid(), field: kqlToField(reM[1] ?? ''), operator: 'matchesRegex', value: reM[2] };
  // isEmpty / isNotEmpty
  const isEmptyM = expr.match(/^isempty\s*\(\s*(.+?)\s*\)$/i);
  if (isEmptyM) return { id: uid(), field: kqlToField(isEmptyM[1] ?? ''), operator: 'isEmpty' };
  const isNotEmptyM = expr.match(/^isnotempty\s*\(\s*(.+?)\s*\)$/i);
  if (isNotEmptyM) return { id: uid(), field: kqlToField(isNotEmptyM[1] ?? ''), operator: 'isNotEmpty' };
  // arrayContains: f[*] has 'v'
  const arrContM = expr.match(/^(.+?)\[?\*?\]?\s+has\s+'([^']*)'$/i);
  if (arrContM) return { id: uid(), field: kqlToField(arrContM[1] ?? ''), operator: 'arrayContains', value: arrContM[2] };
  // between: tolong(f) between (lo .. hi)
  const betweenM = expr.match(/^tolong\s*\(\s*(.+?)\s*\)\s+between\s*\(\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*\)$/i);
  if (betweenM) return { id: uid(), field: kqlToField(betweenM[1] ?? ''), operator: 'between', value: betweenM[2], value2: betweenM[3] };
  // bare numeric comparison without tolong() wrapper (hand-written KQL); must run after
  // the specific tolong/array_length/todatetime cases above so it doesn't shadow them
  const bareCmpM = expr.match(/^(.+?)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (bareCmpM) {
    const CMP_OPS: Record<string, VisualFilterOperator> = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };
    const op = CMP_OPS[bareCmpM[2] ?? ''];
    if (op) return { id: uid(), field: kqlToField(bareCmpM[1] ?? ''), operator: op, value: bareCmpM[3] };
  }
  // bare boolean field reference used as a condition: `| where hasFeatureX` → isTrue
  if (isBareFieldPath(expr)) return { id: uid(), field: kqlToField(expr), operator: 'isTrue' };

  // Fall back to legacy simple-condition parser
  const legacy = parseSimpleCondition(expr);
  if (!legacy) return null;
  const OP_MAP: Partial<Record<ConditionOperator, VisualFilterOperator>> = {
    exists: 'exists', notExists: 'notExists', equals: 'equals', notEquals: 'notEquals',
    in: 'in', notIn: 'notIn', contains: 'contains', notContains: 'notContains',
    startsWith: 'startsWith', endsWith: 'endsWith', matches: 'matchesRegex',
  };
  const visualOp = OP_MAP[legacy.operator];
  if (!visualOp) return null;
  return { id: uid(), field: legacy.field, operator: visualOp, value: legacy.value, values: legacy.values };
}

// ── Simple-condition parser ───────────────────────────────────────────────────
// Fallback used by parseVisualConditionExpr for patterns its own regexes don't cover.

function parseSimpleCondition(e: string): Condition | null {
  e = e.trim();
  const existsM = e.match(/^isnotempty\s*\(\s*tostring\s*\(\s*(.+?)\s*\)\s*\)$/i);
  if (existsM) return { field: kqlToField(existsM[1] ?? ''), operator: 'exists' };
  const notExM = e.match(/^isempty\s*\(\s*tostring\s*\(\s*(.+?)\s*\)\s*\)$/i);
  if (notExM) return { field: kqlToField(notExM[1] ?? ''), operator: 'notExists' };
  const eqM = e.match(/^(.+?)\s*=~\s*'([^']*)'$/);
  if (eqM) return { field: kqlToField(eqM[1] ?? ''), operator: 'equals', value: eqM[2] ?? '' };
  const neqM = e.match(/^(.+?)\s*!~\s*'([^']*)'$/);
  if (neqM) return { field: kqlToField(neqM[1] ?? ''), operator: 'notEquals', value: neqM[2] ?? '' };
  const inM = e.match(/^(.+?)\s+in~\s*\(([^)]+)\)$/i);
  if (inM) return { field: kqlToField(inM[1] ?? ''), operator: 'in', values: splitQ(inM[2] ?? '') };
  const notInM = e.match(/^not\s*\(\s*(.+?)\s+in~\s*\(([^)]+)\)\s*\)$/i);
  if (notInM) return { field: kqlToField(notInM[1] ?? ''), operator: 'notIn', values: splitQ(notInM[2] ?? '') };
  const containsM = e.match(/^(.+?)\s+contains\s+'([^']*)'$/i);
  if (containsM) return { field: kqlToField(containsM[1] ?? ''), operator: 'contains', value: containsM[2] ?? '' };
  const notContM = e.match(/^not\s*\(\s*(.+?)\s+contains\s+'([^']*)'\s*\)$/i);
  if (notContM) return { field: kqlToField(notContM[1] ?? ''), operator: 'notContains', value: notContM[2] ?? '' };
  const swM = e.match(/^(.+?)\s+startswith\s+'([^']*)'$/i);
  if (swM) return { field: kqlToField(swM[1] ?? ''), operator: 'startsWith', value: swM[2] ?? '' };
  const ewM = e.match(/^(.+?)\s+endswith\s+'([^']*)'$/i);
  if (ewM) return { field: kqlToField(ewM[1] ?? ''), operator: 'endsWith', value: ewM[2] ?? '' };
  const regexM = e.match(/^(.+?)\s+matches\s+regex\s+'([^']*)'$/i);
  if (regexM) return { field: kqlToField(regexM[1] ?? ''), operator: 'matches', value: regexM[2] ?? '' };
  return null;
}

export type { ConditionOperator };
