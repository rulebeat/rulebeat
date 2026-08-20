'use client';

/* No hooks and no portal in this file any more. Every piece of dropdown state
 * (open/closed, position, click-outside, keyboard) now lives in the shared menu
 * and select; what is left here is a pure render of the query the parent holds. */

import { Plus, Trash2, ChevronDown, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fieldBase, Label } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select, SelectContent, SelectGroup, SelectGroupLabel, SelectItem, SelectRoot, SelectTrigger, SelectValue,
  type SelectOption,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { FieldCombobox } from './field-combobox';
import type {
  AggregateStage,
  ComputeStage,
  ExpandStage,
  FilterStage,
  JoinStage,
  LimitStage,
  QueryStage,
  RawStage,
  ShapeStage,
  SortColumn, SortStage,
  VisualFilterCondition, VisualFilterGroup, VisualFilterOperator,
  VisualQuery,
} from '@/lib/kql';

// ── Stage metadata ────────────────────────────────────────────────────────────

/* Each stage used to carry its own hue: purple for compute, teal for expand,
 * orange for aggregate, red for join. Eight stages meant eight colours on one
 * screen, none of which meant anything, and the red one read as an error.
 * Stages are told apart by their name, which is what a name is for. */
const STAGE_CONFIG = {
  filter:    { label: 'Filter conditions', description: 'Keep only resources that match all conditions below.' },
  compute:   { label: 'Calculate columns', description: 'Add new calculated columns to each row using functions or fields.' },
  expand:    { label: 'Loop over array',   description: 'Split an array field so each element becomes its own row.' },
  aggregate: { label: 'Group & summarize', description: 'Group rows and compute counts, totals, or lists across groups.' },
  join:      { label: 'Combine queries',   description: 'Match rows from this result with rows from another resource query.' },
  sort:      { label: 'Sort results',      description: 'Order the results by one or more fields.' },
  limit:     { label: 'Limit results',     description: 'Cap the number of results returned.' },
  shape:     { label: 'Select columns',    description: 'Choose which columns to keep or remove from the output.' },
} as const;

const STAGE_MENU_GROUPS = [
  {
    label: 'Common',
    items: [
      { type: 'filter'    as const, label: 'Filter resources where…',   desc: 'Keep only resources matching your conditions' },
      { type: 'sort'      as const, label: 'Sort results',               desc: 'Order by one or more fields' },
      { type: 'limit'     as const, label: 'Limit results',              desc: 'Cap the number of results returned' },
    ],
  },
];

// ── Filter operator metadata (Layer 1) ───────────────────────────────────────

type ValueType = 'none' | 'text' | 'number' | 'number2' | 'multi';
interface OpMeta { value: VisualFilterOperator; label: string; group: string; valueType: ValueType; placeholder?: string; placeholder2?: string; unit?: string }

const FILTER_OPS: OpMeta[] = [
  { value: 'notExists',      label: 'does not exist',        group: 'Existence',    valueType: 'none' },
  { value: 'exists',         label: 'exists',                group: 'Existence',    valueType: 'none' },
  { value: 'isEmpty',        label: 'is empty',              group: 'Existence',    valueType: 'none' },
  { value: 'isNotEmpty',     label: 'is not empty',          group: 'Existence',    valueType: 'none' },
  { value: 'isNull',         label: 'is null',               group: 'Existence',    valueType: 'none' },
  { value: 'isNotNull',      label: 'is not null',           group: 'Existence',    valueType: 'none' },
  { value: 'isTrue',         label: 'is true',               group: 'Booleans',     valueType: 'none' },
  { value: 'isFalse',        label: 'is false',              group: 'Booleans',     valueType: 'none' },
  { value: 'equals',         label: 'equals',                group: 'Text / String',valueType: 'text',   placeholder: 'value' },
  { value: 'notEquals',      label: 'does not equal',        group: 'Text / String',valueType: 'text',   placeholder: 'value' },
  { value: 'contains',       label: 'contains',              group: 'Text / String',valueType: 'text',   placeholder: 'substring' },
  { value: 'notContains',    label: 'does not contain',      group: 'Text / String',valueType: 'text',   placeholder: 'substring' },
  { value: 'startsWith',     label: 'starts with',           group: 'Text / String',valueType: 'text',   placeholder: 'prefix' },
  { value: 'notStartsWith',  label: 'does not start with',   group: 'Text / String',valueType: 'text',   placeholder: 'prefix' },
  { value: 'endsWith',       label: 'ends with',             group: 'Text / String',valueType: 'text',   placeholder: 'suffix' },
  { value: 'notEndsWith',    label: 'does not end with',     group: 'Text / String',valueType: 'text',   placeholder: 'suffix' },
  { value: 'matchesRegex',   label: 'matches regex',         group: 'Text / String',valueType: 'text',   placeholder: '^pattern$' },
  { value: 'has',            label: 'has token',             group: 'Text / String',valueType: 'text',   placeholder: 'word' },
  { value: 'notHas',         label: 'does not have token',   group: 'Text / String',valueType: 'text',   placeholder: 'word' },
  { value: 'hasAny',         label: 'has any token',         group: 'Text / String',valueType: 'multi',  placeholder: 'word1, word2…' },
  { value: 'gt',             label: 'greater than',          group: 'Numbers',      valueType: 'number', placeholder: 'number' },
  { value: 'gte',            label: 'greater than or equal', group: 'Numbers',      valueType: 'number', placeholder: 'number' },
  { value: 'lt',             label: 'less than',             group: 'Numbers',      valueType: 'number', placeholder: 'number' },
  { value: 'lte',            label: 'less than or equal',    group: 'Numbers',      valueType: 'number', placeholder: 'number' },
  { value: 'between',        label: 'between',               group: 'Numbers',      valueType: 'number2',placeholder: 'min', placeholder2: 'max' },
  { value: 'olderThanDays',  label: 'older than',            group: 'Time / Age',   valueType: 'number', placeholder: '90', unit: 'days' },
  { value: 'withinLastDays', label: 'within last',           group: 'Time / Age',   valueType: 'number', placeholder: '30', unit: 'days' },
  { value: 'arrayEmpty',     label: 'array is empty',        group: 'Arrays',       valueType: 'none' },
  { value: 'arrayNotEmpty',  label: 'array is not empty',    group: 'Arrays',       valueType: 'none' },
  { value: 'arrayLengthGt',  label: 'array length greater than', group: 'Arrays',   valueType: 'number', placeholder: 'count' },
  { value: 'arrayLengthLte', label: 'array length at most',  group: 'Arrays',       valueType: 'number', placeholder: 'count' },
  { value: 'arrayContains',  label: 'array contains value',  group: 'Arrays',       valueType: 'text',   placeholder: 'value' },
  { value: 'in',             label: 'is one of',             group: 'Value Lists',  valueType: 'multi',  placeholder: 'val1, val2…' },
  { value: 'notIn',          label: 'is not one of',         group: 'Value Lists',  valueType: 'multi',  placeholder: 'val1, val2…' },
];
const OP_GROUPS = [...new Set(FILTER_OPS.map(o => o.group))];
const OP_MAP    = new Map(FILTER_OPS.map(o => [o.value, o]));

// Option lists for the small fixed dropdowns. They read as KQL keywords rather than
// prose ("asc", "take") because that is what ends up in the generated query, and the
// person editing this is looking at the query pane next to it.
const SORT_DIRECTIONS: readonly SelectOption[] = [
  { value: 'asc',  label: 'asc'  },
  { value: 'desc', label: 'desc' },
];
const LIMIT_MODES: readonly SelectOption[] = [
  { value: 'take', label: 'take' },
  { value: 'top',  label: 'top'  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return crypto.randomUUID(); }

function newFilterCond(): VisualFilterCondition { return { id: uid(), field: '', operator: 'notExists' }; }
function newFilterGroup(): VisualFilterGroup    { return { id: uid(), conditions: [newFilterCond()] }; }
function newFilterStage(): FilterStage          { return { id: uid(), type: 'filter', groups: [newFilterGroup()] }; }

export function defaultVisualQuery(): VisualQuery { return { stages: [newFilterStage()] }; }

// FieldCombobox takes a className for its own <input>, so the shared field styling
// is composed here rather than imported as a component.
const inputCls = cn(fieldBase, 'h-8 px-2 text-xs');

/* The and/or toggle between conditions and between groups.
 *
 * "or" is the state worth marking, because it is the one that changes what the
 * rule means and the one people misread. It gets a solid ink fill; "and", the
 * default, stays quiet. This used to be amber, which read as a warning. */
function joinToggleCls(isOr: boolean) {
  return cn(
    'border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors outline-none',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
    isOr
      ? 'border-ink bg-ink text-surface'
      : 'border-border bg-surface text-ink-2 hover:border-rule-strong hover:text-ink',
  );
}

// ── Stage wrapper ─────────────────────────────────────────────────────────────

function StageWrapper({ type, index, children, onRemove, canRemove, extra }: {
  type: keyof typeof STAGE_CONFIG;
  index: number;
  children: React.ReactNode;
  onRemove: () => void;
  canRemove: boolean;
  extra?: React.ReactNode;
}) {
  const cfg = STAGE_CONFIG[type];
  return (
    <div className="bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-sunken px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* The number is not decoration. Stages run top to bottom and each one feeds
              the next, so its position is the single most useful thing to know about it. */}
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className="label-grid-strong truncate">{cfg.label}</span>
        </div>
        <div className="flex items-center gap-1">
          {extra}
          {canRemove && (
            <Button variant="ghost" size="icon-sm" onClick={onRemove} title="Remove stage">
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div className="border-b border-border px-3 py-2">
        <p className="text-xs text-ink-2">{cfg.description}</p>
      </div>
      <div className="p-2.5">{children}</div>
    </div>
  );
}

// ── Add-stage dropdown ────────────────────────────────────────────────────────

/* This used to be a hand-rolled portal: its own getBoundingClientRect, its own
 * flip-when-there-is-no-room-below maths, its own scroll listener and its own
 * outside-click handler, roughly eighty lines of it. All of that now lives once
 * in the shared menu. */
function AddStageButton({ onAdd, label = 'Add stage' }: { onAdd: (type: QueryStage['type']) => void; label?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex h-8 items-center gap-1.5 border border-dashed border-rule-strong px-3 text-xs font-medium text-ink-2',
          'transition-colors outline-none hover:bg-surface-hover hover:text-ink',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        )}
      >
        <Plus className="size-3.5" />
        {label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {STAGE_MENU_GROUPS.map((group, gi) => (
          <DropdownMenuGroup key={group.label}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {group.items.map(item => (
              <DropdownMenuItem
                key={item.type}
                onClick={() => onAdd(item.type)}
                className="flex-col items-start gap-0.5 py-2"
              >
                <span className="text-xs font-medium">{item.label}</span>
                {/* Inherits the item's colour at reduced opacity rather than taking a muted
                    token, so it stays readable when the row is highlighted to solid ink. */}
                <span className="text-xs opacity-70">{item.desc}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Layer 1: FilterStage ──────────────────────────────────────────────────────

function ConditionRow({ cond, fields, onChange, onRemove, canRemove }: {
  cond: VisualFilterCondition;
  fields: string[];
  onChange: (c: VisualFilterCondition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const meta = OP_MAP.get(cond.operator);
  const vt   = meta?.valueType ?? 'text';

  // A condition the builder has no operator for — the same passthrough deal the advanced stages get.
  // Shown as its own KQL so it is readable, and written back out untouched; edit it in the KQL pane.
  if (cond.operator === 'raw') {
    return (
      <div className="flex items-start gap-2 border border-border bg-surface-sunken p-2.5">
        {/* Not `label-grid` — that utility sets its own colour, and this badge needs to
            invert on an ink fill. Overriding a utility's colour from outside it is a
            specificity race nobody wins. */}
        <span className="mt-1 shrink-0 bg-ink px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-surface">
          KQL
        </span>
        <code className="min-w-0 flex-1 break-all pt-1 font-mono text-xs text-ink">{cond.rawExpr}</code>
        {/* The icon takes no colour of its own. `ghost` already sets one and changes
            it on hover, so colouring the icon here would freeze it. */}
        <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={onRemove} disabled={!canRemove} title="Remove condition">
          <Trash2 />
        </Button>
      </div>
    );
  }

  function setOp(op: VisualFilterOperator) {
    const newVt = OP_MAP.get(op)?.valueType ?? 'text';
    onChange({ ...cond, operator: op, value: newVt === vt ? cond.value : undefined, value2: undefined, values: newVt === vt ? cond.values : undefined });
  }

  return (
    <div className="flex items-start gap-2 border border-border bg-surface-sunken p-2.5">
      <div style={{ width: 190 }} className="shrink-0">
        <FieldCombobox value={cond.field} onChange={f => onChange({ ...cond, field: f })} options={fields} placeholder="field…" className={inputCls + ' w-full'} />
      </div>
      {/* Grouped options, so this uses the composable Select parts rather than the
          convenience form. It replaced a native <select> with <optgroup>: the browser
          painted that popup itself, which meant it stayed light in dark mode and looked
          different on every operating system. */}
      <SelectRoot value={cond.operator} onValueChange={next => setOp(String(next) as VisualFilterOperator)}>
        <SelectTrigger size="sm" className="w-44 shrink-0 text-xs">
          <SelectValue>{current => OP_MAP.get(current as VisualFilterOperator)?.label ?? String(current)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {OP_GROUPS.map(g => (
            <SelectGroup key={g}>
              <SelectGroupLabel>{g}</SelectGroupLabel>
              {FILTER_OPS.filter(o => o.group === g).map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </SelectRoot>
      {vt === 'text'    && <input value={cond.value ?? ''} onChange={e => onChange({ ...cond, value: e.target.value })} placeholder={meta?.placeholder} className={`${inputCls} flex-1`} />}
      {vt === 'number'  && (
        <div className="flex items-center gap-1 shrink-0">
          <input type="number" value={cond.value ?? ''} onChange={e => onChange({ ...cond, value: e.target.value })} placeholder={meta?.placeholder} className={`${inputCls} w-24`} />
          {meta?.unit && <span className="text-xs text-ink-2">{meta.unit}</span>}
        </div>
      )}
      {vt === 'number2' && (
        <div className="flex items-center gap-1.5 shrink-0">
          <input type="number" value={cond.value ?? ''} onChange={e => onChange({ ...cond, value: e.target.value })} placeholder={meta?.placeholder} className={`${inputCls} w-20`} />
          <span className="text-xs text-ink-2">to</span>
          <input type="number" value={cond.value2 ?? ''} onChange={e => onChange({ ...cond, value2: e.target.value })} placeholder={meta?.placeholder2} className={`${inputCls} w-20`} />
        </div>
      )}
      {vt === 'multi'   && <input value={(cond.values ?? []).join(', ')} onChange={e => onChange({ ...cond, values: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })} placeholder={meta?.placeholder} className={`${inputCls} flex-1`} />}
      {vt === 'none'    && <div className="flex-1" />}
      <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={onRemove} disabled={!canRemove} title="Remove condition">
        <Trash2 />
      </Button>
    </div>
  );
}

function FilterStageBlock({ stage, index, fields, onChange, onRemove, canRemove }: {
  stage: FilterStage; index: number; fields: string[];
  onChange: (s: FilterStage) => void; onRemove: () => void; canRemove: boolean;
}) {
  const upd = (gi: number, g: VisualFilterGroup) => onChange({ ...stage, groups: stage.groups.map((x, i) => i === gi ? g : x) });

  return (
    <StageWrapper type="filter" index={index} onRemove={onRemove} canRemove={canRemove}
      extra={<Button variant="ghost" size="xs" onClick={() => onChange({ ...stage, groups: [...stage.groups, newFilterGroup()] })}><Plus className="size-3" />Add group</Button>}
    >
      <div className="space-y-2">
        {stage.groups.map((group, gi) => (
          <div key={group.id}>
            {gi > 0 && (
              <div className="my-1.5 flex items-center gap-2">
                <div className="flex-1 border-t border-dashed border-border" />
                <button type="button" onClick={() => upd(gi, { ...group, join: (group.join ?? 'or') === 'or' ? 'and' : 'or' })}
                  className={joinToggleCls((group.join ?? 'or') === 'or')}>
                  {group.join ?? 'or'}
                </button>
                <div className="flex-1 border-t border-dashed border-border" />
              </div>
            )}
            <div className="border border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border bg-surface-sunken px-2.5 py-1.5">
                <span className="label-grid">Group {gi + 1}</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="xs"
                    onClick={() => upd(gi, { ...group, conditions: [...group.conditions, newFilterCond()] })}>
                    <Plus className="size-2.5" />Add condition
                  </Button>
                  {stage.groups.length > 1 && (
                    <Button variant="ghost" size="icon-sm"
                      onClick={() => onChange({ ...stage, groups: stage.groups.filter((_, i) => i !== gi) })}>
                      <Trash2 className="size-3" />
                    </Button>
                  )}
                </div>
              </div>
              <div className="space-y-1.5 p-2">
                {group.conditions.length === 0 && <p className="px-1 text-xs text-ink-muted">No conditions. Add one above.</p>}
                {group.conditions.map((cond, ci) => (
                  <div key={cond.id}>
                    {ci > 0 && (
                      <div className="flex items-center gap-2 py-0.5">
                        <div className="flex-1 border-t border-dashed border-border" />
                        <button type="button" onClick={() => upd(gi, { ...group, conditions: group.conditions.map((x, j) => j === ci ? { ...x, join: (x.join ?? 'and') === 'and' ? 'or' : 'and' } : x) })}
                          className={joinToggleCls((cond.join ?? 'and') === 'or')}>
                          {cond.join ?? 'and'}
                        </button>
                        <div className="flex-1 border-t border-dashed border-border" />
                      </div>
                    )}
                    <ConditionRow cond={cond} fields={fields}
                      onChange={c => upd(gi, { ...group, conditions: group.conditions.map((x, j) => j === ci ? c : x) })}
                      onRemove={() => upd(gi, { ...group, conditions: group.conditions.filter((_, j) => j !== ci) })}
                      canRemove={group.conditions.length > 1} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </StageWrapper>
  );
}

// ── Advanced stage passthrough (compute / expand / aggregate / join) ──────────
// These stage types are preserved in the type system and KQL engine but are not
// editable in the builder. When present (e.g. parsed from raw KQL), they render
// as a read-only block pointing users to the KQL pane.

const ADVANCED_STAGE_LABELS: Partial<Record<QueryStage['type'], string>> = {
  compute:   'Calculate Columns',
  expand:    'Loop Over Array',
  aggregate: 'Group & Summarize',
  join:      'Combine Queries',
  shape:     'Select Columns',
  raw:       'Advanced Query (KQL)',
};

function AdvancedPassthroughBlock({ type, onRemove, canRemove, readOnly }: {
  type: QueryStage['type']; onRemove: () => void; canRemove: boolean; readOnly?: boolean;
}) {
  const label = ADVANCED_STAGE_LABELS[type] ?? type;
  return (
    <div className="bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-sunken px-3 py-2">
        <span className="label-grid-strong">{label}</span>
        {canRemove && !readOnly && (
          <Button variant="ghost" size="icon-sm" onClick={onRemove} title="Remove stage">
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="flex items-start gap-3 px-4 py-3">
        <Wrench className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden="true" />
        <div>
          {readOnly ? (
            <>
              <p className="text-xs font-medium text-ink">{label}, shown in the KQL query above</p>
              <p className="mt-0.5 text-xs text-ink-2">This stage uses advanced KQL features. The full query is visible in the KQL pane.</p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium text-ink">{label}, edit in the KQL pane above</p>
              <p className="mt-0.5 text-xs text-ink-2">This stage is too complex to configure in the builder. It runs correctly in Azure. Use the KQL pane to modify it.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ComputeStageBlock({ onRemove, canRemove, readOnly }: { stage: ComputeStage; onRemove: () => void; canRemove: boolean; readOnly?: boolean }) {
  return <AdvancedPassthroughBlock type="compute" onRemove={onRemove} canRemove={canRemove} readOnly={readOnly} />;
}
function ExpandStageBlock({ onRemove, canRemove, readOnly }: { stage: ExpandStage; onRemove: () => void; canRemove: boolean; readOnly?: boolean }) {
  return <AdvancedPassthroughBlock type="expand" onRemove={onRemove} canRemove={canRemove} readOnly={readOnly} />;
}
function AggregateStageBlock({ onRemove, canRemove, readOnly }: { stage: AggregateStage; onRemove: () => void; canRemove: boolean; readOnly?: boolean }) {
  return <AdvancedPassthroughBlock type="aggregate" onRemove={onRemove} canRemove={canRemove} readOnly={readOnly} />;
}

// ── JoinStage ─────────────────────────────────────────────────────────────────

function JoinStageBlock({ onRemove, canRemove, readOnly }: { stage: JoinStage; onRemove: () => void; canRemove: boolean; readOnly?: boolean }) {
  return <AdvancedPassthroughBlock type="join" onRemove={onRemove} canRemove={canRemove} readOnly={readOnly} />;
}

// ── Layer 5: SortStage ────────────────────────────────────────────────────────

function SortStageBlock({ stage, index, fields, onChange, onRemove, canRemove }: {
  stage: SortStage; index: number; fields: string[];
  onChange: (s: SortStage) => void; onRemove: () => void; canRemove: boolean;
}) {
  const newCol = (): SortColumn => ({ field: '', direction: 'asc' });
  return (
    <StageWrapper type="sort" index={index} onRemove={onRemove} canRemove={canRemove}
      extra={<Button variant="ghost" size="xs" onClick={() => onChange({ ...stage, columns: [...stage.columns, newCol()] })}><Plus className="size-3" />Add column</Button>}
    >
      <div className="space-y-2">
        {stage.columns.length === 0 && <p className="px-1 text-xs text-ink-muted">No sort columns. Add one above.</p>}
        {stage.columns.map((col, i) => (
          <div key={i} className="flex items-center gap-2 border border-border bg-surface-sunken p-2.5">
            <div className="min-w-0 flex-1">
              <FieldCombobox value={col.field} onChange={f => onChange({ ...stage, columns: stage.columns.map((x, j) => j === i ? { ...x, field: f } : x) })} options={fields} placeholder="field" className={inputCls + ' w-full'} />
            </div>
            <Select
              size="sm"
              className="w-24 shrink-0 text-xs"
              aria-label="Sort direction"
              value={col.direction}
              onValueChange={v => onChange({ ...stage, columns: stage.columns.map((x, j) => j === i ? { ...x, direction: v as 'asc' | 'desc' } : x) })}
              options={SORT_DIRECTIONS}
            />
            <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={() => onChange({ ...stage, columns: stage.columns.filter((_, j) => j !== i) })} disabled={stage.columns.length <= 1}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </StageWrapper>
  );
}

// ── Layer 5: LimitStage ───────────────────────────────────────────────────────

function LimitStageBlock({ stage, index, fields, onChange, onRemove, canRemove }: {
  stage: LimitStage; index: number; fields: string[];
  onChange: (s: LimitStage) => void; onRemove: () => void; canRemove: boolean;
}) {
  return (
    <StageWrapper type="limit" index={index} onRemove={onRemove} canRemove={canRemove}>
      <div className="flex items-end gap-4">
        <div>
          <Label className="mb-1.5">Mode</Label>
          <Select
            size="sm"
            className="w-24 text-xs"
            aria-label="Limit mode"
            value={stage.mode}
            onValueChange={v => onChange({ ...stage, mode: v as 'take' | 'top' })}
            options={LIMIT_MODES}
          />
        </div>
        <div>
          <Label className="mb-1.5">Count *</Label>
          <input type="number" min={1} value={stage.count || ''} onChange={e => onChange({ ...stage, count: parseInt(e.target.value, 10) || 0 })} placeholder="100" className={`${inputCls} w-24`} />
        </div>
        {stage.mode === 'top' && (
          <>
            <div className="flex-1 min-w-0">
              <Label className="mb-1.5">Order by field</Label>
              <FieldCombobox value={stage.orderBy?.field ?? ''} onChange={f => onChange({ ...stage, orderBy: { field: f, direction: stage.orderBy?.direction ?? 'desc' } })} options={fields} placeholder="field" className={inputCls + ' w-full'} />
            </div>
            <div>
              <Label className="mb-1.5">Direction</Label>
              <Select
                size="sm"
                className="w-24 text-xs"
                aria-label="Order direction"
                value={stage.orderBy?.direction ?? 'desc'}
                onValueChange={v => onChange({ ...stage, orderBy: { field: stage.orderBy?.field ?? '', direction: v as 'asc' | 'desc' } })}
                options={SORT_DIRECTIONS}
              />
            </div>
          </>
        )}
      </div>
      {stage.mode === 'top' && <p className="mt-2 text-xs text-ink-2">Returns the top N rows ranked by the chosen field.</p>}
      {stage.mode === 'take' && <p className="mt-2 text-xs text-ink-2">Returns N rows in no particular order. Fastest for sampling.</p>}
    </StageWrapper>
  );
}

// ── Layer 5: ShapeStage ───────────────────────────────────────────────────────

function ShapeStageBlock({ onRemove, canRemove, readOnly }: { stage: ShapeStage; onRemove: () => void; canRemove: boolean; readOnly?: boolean }) {
  return <AdvancedPassthroughBlock type="shape" onRemove={onRemove} canRemove={canRemove} readOnly={readOnly} />;
}

// ── Passthrough: RawStage (e.g. `| union (...)`) ──────────────────────────────

function RawStageBlock({ onRemove, canRemove, readOnly }: { stage: RawStage; onRemove: () => void; canRemove: boolean; readOnly?: boolean }) {
  return <AdvancedPassthroughBlock type="raw" onRemove={onRemove} canRemove={canRemove} readOnly={readOnly} />;
}

// ── Pipeline connector ────────────────────────────────────────────────────────

function PipeConnector({ onInsert }: { onInsert: (type: QueryStage['type']) => void }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex-1 border-t border-dashed border-rule-faint" />
      <AddStageButton onAdd={onInsert} label="Insert stage" />
      <div className="flex-1 border-t border-dashed border-rule-faint" />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function VisualQueryBuilder({ query, onChange, fields, readOnly, heading }: {
  query: VisualQuery;
  onChange: (q: VisualQuery) => void;
  fields: string[];
  readOnly?: boolean;
  // Not rendered as visible text — the call site's own CardTitle already shows this. Exposed as
  // an accessible name so two builder instances on one page (Violates when / Applies to) can be
  // told apart by screen readers and by test selectors querying accessible role/name.
  heading: string;
}) {
  function updateStage(i: number, s: QueryStage) {
    onChange({ ...query, stages: query.stages.map((x, j) => j === i ? s : x) });
  }
  function removeStage(i: number) {
    const next = query.stages.filter((_, j) => j !== i);
    onChange({ ...query, stages: next.length > 0 ? next : [newFilterStage()] });
  }
  function addStageAt(type: QueryStage['type'], insertIdx?: number): void {
    const newStage = makeDefaultStage(type);
    if (insertIdx !== undefined) {
      const stages = [...query.stages];
      stages.splice(insertIdx, 0, newStage);
      onChange({ ...query, stages });
    } else {
      onChange({ ...query, stages: [...query.stages, newStage] });
    }
  }

  return (
    <div role="group" aria-label={heading} className={readOnly ? 'pointer-events-none select-none opacity-75' : ''}>
    <div className="space-y-1">
      <p className="mb-3 px-0.5 text-xs leading-relaxed text-ink-2">
        Build your query by stacking stages. Each stage filters, transforms, or shapes the resources from the stage above it. The KQL pane at the top updates live as you build.
      </p>

      {query.stages.map((stage, si) => (
        <div key={stage.id}>
          {si > 0 && <PipeConnector onInsert={type => addStageAt(type, si)} />}
          {renderStage(stage, si, fields, updateStage, removeStage, query.stages.length, readOnly)}
        </div>
      ))}

      <div className="pt-2">
        <AddStageButton onAdd={type => addStageAt(type)} label="Add stage" />
      </div>
    </div>
    </div>
  );
}

function renderStage(
  stage: QueryStage, index: number, fields: string[],
  updateStage: (i: number, s: QueryStage) => void,
  removeStage: (i: number) => void,
  total: number,
  readOnly?: boolean,
): React.ReactNode {
  const canRemove = total > 1;
  const props = { index, fields, onRemove: () => removeStage(index), canRemove };

  switch (stage.type) {
    case 'filter':    return <FilterStageBlock    key={stage.id} stage={stage} {...props} onChange={s => updateStage(index, s)} />;
    case 'compute':   return <ComputeStageBlock   key={stage.id} stage={stage} onRemove={props.onRemove} canRemove={canRemove} readOnly={readOnly} />;
    case 'expand':    return <ExpandStageBlock    key={stage.id} stage={stage} onRemove={props.onRemove} canRemove={canRemove} readOnly={readOnly} />;
    case 'aggregate': return <AggregateStageBlock key={stage.id} stage={stage} onRemove={props.onRemove} canRemove={canRemove} readOnly={readOnly} />;
    case 'join':      return <JoinStageBlock      key={stage.id} stage={stage} onRemove={() => removeStage(index)} canRemove={canRemove} readOnly={readOnly} />;
    case 'sort':      return <SortStageBlock      key={stage.id} stage={stage} {...props} onChange={s => updateStage(index, s)} />;
    case 'limit':     return <LimitStageBlock     key={stage.id} stage={stage} {...props} onChange={s => updateStage(index, s)} />;
    case 'shape':     return <ShapeStageBlock     key={stage.id} stage={stage} onRemove={props.onRemove} canRemove={canRemove} readOnly={readOnly} />;
    case 'raw':       return <RawStageBlock       key={stage.id} stage={stage} onRemove={props.onRemove} canRemove={canRemove} readOnly={readOnly} />;
  }
}

function makeDefaultStage(type: QueryStage['type']): QueryStage {
  switch (type) {
    case 'filter':    return newFilterStage();
    case 'compute':   return { id: uid(), type: 'compute', columns: [{ id: uid(), alias: '', exprType: 'raw', rawExpr: '' }] };
    case 'expand':    return { id: uid(), type: 'expand', field: '' };
    case 'aggregate': return { id: uid(), type: 'aggregate', columns: [{ id: uid(), alias: 'Count', fn: 'count' }], groupBy: [] };
    case 'join':      return { id: uid(), type: 'join', kind: 'leftouter', rightQuery: '', onLeft: 'id', onRight: 'id' };
    case 'sort':      return { id: uid(), type: 'sort', columns: [{ field: '', direction: 'asc' }] };
    case 'limit':     return { id: uid(), type: 'limit', mode: 'take', count: 100 };
    case 'shape':     return { id: uid(), type: 'shape', mode: 'project', columns: [] };
    // Never reachable from the UI — 'raw' is parser-only and deliberately excluded from
    // STAGE_MENU_GROUPS, so this branch only exists to keep the switch exhaustive.
    case 'raw':       return { id: uid(), type: 'raw', clause: '' };
  }
}
