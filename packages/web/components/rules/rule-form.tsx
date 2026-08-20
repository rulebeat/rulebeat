'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Callout, CalloutPanel } from '@/components/ui/callout';
import { CodeBlock } from '@/components/ui/code-block';
import { Input, Label, Textarea, fieldBase } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type {
  Category, Condition, ConditionGroup, ConditionOperator, GraphQuery, LogAnalyticsQuery, ModuleCategory, QueryBackend, Rule, RuleScope, Severity,
} from '@/lib/types';
import { HelpCircle, Copy, Check, Play, ExternalLink, Lock, Sparkles } from 'lucide-react';
import { FieldCombobox } from './field-combobox';
import { ResourceTypeInput } from './resource-type-input';
import { ScopeTreePicker } from './scope-tree-picker';
import { TagPicker } from './tag-picker';
import type { LockedTag } from './tag-picker';
import { PACK_LABELS } from '@/lib/pack-labels';
import { classifySchemaStatus } from '@/lib/schema-fetch-status';
import { splitLearnMore } from '@/lib/rule-description';
import { buildQueryFromVisual, parseKqlToVisualQuery, hasCompilableFilter, DEFAULT_PROJECT_COLUMNS } from '@/lib/kql';
import type { VisualQuery, VisualFilterCondition, VisualFilterOperator, FilterStage } from '@/lib/kql';
import { isVisualQueryStale } from '@/lib/rule-visual-query-drift';
import { VisualQueryBuilder, defaultVisualQuery } from './visual-query-builder';
import { GraphRuleEditor } from './graph-rule-editor';
import { LogAnalyticsRuleEditor } from './log-analytics-rule-editor';
import { deriveDedicatedEditorFields } from '@/lib/rule-form-payload';

// Always-available ARG fields in the condition field autocomplete.
const ARG_BASE_FIELDS = ['subscriptionId', 'resourceGroup', 'id', 'name', 'type', 'location', 'tags', 'kind', 'sku'];

const COMMON_RESOURCE_TYPES_LIST = [
  'microsoft.compute/virtualmachines', 'microsoft.compute/disks', 'microsoft.compute/snapshots',
  'microsoft.compute/virtualmachinescalesets', 'microsoft.storage/storageaccounts',
  'microsoft.network/virtualnetworks', 'microsoft.network/networksecuritygroups',
  'microsoft.network/publicipaddresses', 'microsoft.network/networkinterfaces',
  'microsoft.network/loadbalancers', 'microsoft.network/applicationgateways',
  'microsoft.keyvault/vaults', 'microsoft.sql/servers', 'microsoft.sql/servers/databases',
  'microsoft.web/sites', 'microsoft.web/serverfarms',
  'microsoft.containerservice/managedclusters', 'microsoft.insights/components',
  'microsoft.operationalinsights/workspaces', 'microsoft.managedidentity/userassignedidentities',
];

// ARG ResourceContainers fields — ARM aliases API returns 0 for container types.
const CONTAINER_FIELDS: Record<string, string[]> = {
  resourceGroup: [
    'id', 'name', 'type', 'location', 'subscriptionId', 'tenantId', 'tags', 'managedBy',
    'properties.provisioningState',
  ],
  subscription: [
    'id', 'name', 'type', 'subscriptionId', 'tenantId', 'tags',
    'properties.displayName', 'properties.state', 'properties.authorizationSource',
    'properties.managedByTenants',
    'properties.subscriptionPolicies.quotaId', 'properties.subscriptionPolicies.spendingLimit',
  ],
  managementGroup: [
    'id', 'name', 'type', 'tenantId',
    'properties.displayName', 'properties.tenantId',
    'properties.details.parent.id', 'properties.details.parent.name', 'properties.details.parent.displayName',
    'properties.details.updatedTime', 'properties.details.updatedBy', 'properties.details.version',
  ],
};

// Only for the two children that take a className rather than rendering an <Input>
// themselves (FieldCombobox, ResourceTypeInput). Everything else on this form uses the
// shared Input, so field height and focus outline are defined in exactly one place.
const inputCls = `${fieldBase.join(' ')} h-9 px-3 text-sm`;

const ARG_TABLE_OPTIONS: readonly SelectOption[] = [
  { value: 'resource',        label: 'Resources' },
  { value: 'resourceGroup',   label: 'Resource Groups' },
  { value: 'subscription',    label: 'Subscriptions' },
  { value: 'managementGroup', label: 'Management Groups' },
];

const SEVERITY_OPTIONS: readonly SelectOption[] = (['critical', 'high', 'medium', 'low', 'info'] as Severity[])
  .map(s => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }));

// Convert legacy conditionGroups / conditions to VisualQuery for backward compat.
function condOpToVisual(op: ConditionOperator): VisualFilterOperator {
  return op === 'matches' ? 'matchesRegex' : op as VisualFilterOperator;
}
function legacyToVisualQuery(conditionGroups: ConditionGroup[], conditions: Condition[]): VisualQuery {
  const src = conditionGroups.length > 0
    ? conditionGroups
    : (conditions.length > 0 ? [{ id: crypto.randomUUID(), conditions }] : []);
  if (src.length === 0) return defaultVisualQuery();
  return {
    stages: [{
      id: crypto.randomUUID(),
      type: 'filter',
      groups: src.map((g, gi) => ({
        id: g.id,
        join: gi === 0 ? undefined : (g.join ?? 'or'),
        conditions: g.conditions.map((c, ci) => ({
          id: c.id ?? crypto.randomUUID(),
          join: ci === 0 ? undefined : (c.join ?? 'and'),
          field: c.field,
          operator: condOpToVisual(c.operator),
          value: c.value,
          values: c.values,
        })),
      })),
    }],
  };
}

/**
 * True when a parsed condition carries real content. A condition with an empty field is the parser's
 * blank placeholder — but a passthrough (`operator: 'raw'`) has no field by design and *is* content,
 * so it must not be mistaken for the placeholder.
 */
function isRealCondition(c: VisualFilterCondition): boolean {
  return c.operator === 'raw' ? Boolean(c.rawExpr?.trim()) : Boolean(c.field.trim());
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }} className="p-1 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink" title="Copy KQL">
      {copied ? <Check className="size-3.5 text-status-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

interface ValidateResult { count: number; samples: { name: string; type: string; resourceGroup: string; subscriptionId: string }[] }

interface RuleFormProps {
  initial?: Rule;
  kqlQuery?: string;
  readOnly?: boolean;
  allTags?: string[];
  categories?: Category[];
  /** Gates tags/enabled, which stay live-editable regardless of readOnly/edit mode. */
  canAuthor?: boolean;
  /**
   * What a brand-new rule (no `initial`) checks against, chosen by ChecksPickerDialog before this
   * form ever mounts (rule-new-client.tsx). Ignored once `initial` is set — an existing rule's
   * backend comes from `initial.queryBackend` instead and can't change via this form either way.
   */
  initialQueryBackend?: QueryBackend;
  /** Notified whenever unsaved changes appear/clear, so an embedding page can gate its own Save control. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Notified whenever a save is in flight, so an embedding page can show its own saving state. */
  onSavingChange?: (saving: boolean) => void;
  /**
   * When set, an embedding page owns the Save control (e.g. placed beside Edit) and triggers it
   * through this ref instead of the form rendering its own bottom Save button. Refreshed every
   * render so it always closes over the latest field values, never a stale one.
   */
  saveHandleRef?: React.MutableRefObject<(() => void) | null>;
}

export function RuleForm({
  initial, kqlQuery, readOnly, allTags = [], categories = [], canAuthor = false, initialQueryBackend,
  onDirtyChange, onSavingChange, saveHandleRef,
}: RuleFormProps) {
  // Every category, plus the rule's own category if it's not (or no longer) in the DB list, so old
  // rules with orphaned category values (e.g. legacy 'networking'/'operations') stay selectable.
  // Category no longer implies backend (spec 029) — a custom rule can be filed under any category.
  const categoryOptions = useMemo(() => {
    const opts = categories.map(c => c.id);
    if (initial?.category && !opts.includes(initial.category)) opts.push(initial.category);
    return opts;
  }, [categories, initial]);
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const [fields, setFields] = useState<string[]>([]);
  const [fetchingFields, setFetchingFields] = useState(false);
  const [fieldsStatus, setFieldsStatus] = useState<string | null>(null);

  const isBuiltinCheck = initial?.type === 'builtin';
  const isReadOnly = isBuiltinCheck || !!readOnly;
  // Tags and the enabled flag stay live-editable regardless of the view/edit toggle above —
  // gated on authoring permission alone, not on isReadOnly. A built-in never enters edit mode
  // at all (the API's PUT handler only allows tags/enabled for it), and a custom rule shouldn't
  // need "Edit" just to flip a switch or add a tag either.
  const operationalReadOnly = !canAuthor;

  // Origin (Built-in/Community/Custom) is its own field, matching the Library table's Type
  // column — it's a permission-bearing classification, not a tag. Pack (e.g. APRL v2) is a
  // sub-classification of type: 'builtin' and is shown as a locked tag chip instead, same as
  // the Library table's Tags column.
  const typeChip = useMemo(() => {
    if (!initial?.type) return null;
    if (initial.type === 'builtin') return { label: 'Built-in', icon: 'lock' as const };
    if (initial.type === 'community') return { label: 'Community', icon: 'sparkles' as const };
    return { label: 'Custom', icon: undefined };
  }, [initial?.type]);

  // What this rule checks against — orthogonal to Origin above. For an existing rule this comes
  // from initial.queryBackend; for a brand-new one it's whatever ChecksPickerDialog captured before
  // this form mounted (initialQueryBackend, see rule-new-client.tsx). Either way it's fixed once
  // this form is on screen — there is no in-form control to change it, the picker dialog is the one
  // place this gets chosen.
  const checksChip = useMemo(() => {
    const backend = initial?.type ? (initial.queryBackend ?? 'resource-graph') : initialQueryBackend;
    if (!backend) return null;
    const label = backend === 'resource-graph' ? 'Resource configuration'
      : backend === 'microsoft-graph' ? 'Directory objects'
      : 'Logs & activity';
    return { label };
  }, [initial, initialQueryBackend]);

  const queryBackend: QueryBackend = initial?.queryBackend ?? initialQueryBackend ?? 'resource-graph';
  const isGraphBackend = queryBackend === 'microsoft-graph';
  const isLogAnalyticsBackend = queryBackend === 'log-analytics';
  // Both backends use their own dedicated editor (GraphRuleEditor / LogAnalyticsRuleEditor) instead
  // of the ARG visual/raw-KQL builder below — every save-gate and payload check that applies to one
  // of them applies to both, so this is the one flag both branch on instead of repeating the pair.
  const usesDedicatedEditor = isGraphBackend || isLogAnalyticsBackend;
  // A built-in's Graph query is permission-gated only, like its Tags/Enabled (a built-in has no
  // view/edit toggle at all). A custom rule's Graph query follows the ordinary view/edit toggle,
  // like the KQL pane. Mirrors exactly what the PUT route accepts for each case. Also used for the
  // Log Analytics editor — the flag name is backend-agnostic despite the "graph" in it.
  const graphQueryReadOnly = isBuiltinCheck ? operationalReadOnly : isReadOnly;

  const lockedTags: LockedTag[] = useMemo(() => {
    if (initial?.type !== 'builtin') return [];
    const pack = initial.pack ?? 'rulebeat-core';
    return [{ label: PACK_LABELS[pack] ?? pack, icon: 'lock' }];
  }, [initial?.type, initial?.pack]);

  // Parse rawKql once (mount only) — feeds the visual builder plus, for rules that don't
  // store resourceTypes/projectColumns explicitly (builtins, APRL), the Query Target and
  // Output Columns display values extracted from the KQL itself.
  const initialParsed = useMemo(
    () => (initial?.rawKql ? parseKqlToVisualQuery(initial.rawKql) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ── Form state ──────────────────────────────────────────────────────────────
  const [name, setName]               = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory]       = useState<ModuleCategory>(initial?.category ?? 'compliance');
  const [severity, setSeverity]       = useState<Severity>(initial?.severity ?? 'medium');
  const [enabled, setEnabled]         = useState(initial?.enabled ?? true);
  const [tags, setTags]               = useState<string[]>(initial?.tags ?? []);
  const [scopeLevel, setScopeLevel]   = useState<RuleScope['level']>(initial?.scope.level ?? initialParsed?.scope.level ?? 'resource');
  const [scopeSubscriptions, setScopeSubscriptions]     = useState<string[]>(initial?.scope.subscriptions ?? []);
  const [scopeManagementGroups, setScopeManagementGroups] = useState<string[]>(initial?.scope.managementGroups ?? []);
  const [scopeNames, setScopeNames]   = useState<Record<string, string>>({});
  const [resourceTypes, setResourceTypes] = useState(() => {
    const own = (initial?.resourceTypes ?? []).filter(t => t && t !== '*');
    if (own.length) return own.join(', ');
    if (initialParsed?.resourceTypes.length) return initialParsed.resourceTypes.join(', ');
    return (initial?.resourceTypes ?? ['*']).join(', ');
  });
  const [projectColumns, setProjectColumns] = useState<string[]>(
    initial?.projectColumns?.length ? initial.projectColumns
      : initialParsed?.projectColumns.length ? initialParsed.projectColumns
      : DEFAULT_PROJECT_COLUMNS
  );
  // In read-only mode, only show Output Columns when they come from real data
  // (stored on the rule or parsed from its KQL) — never the generic defaults.
  const projectColumnsKnown = !!(initial?.projectColumns?.length || initialParsed?.projectColumns.length);
  const [addColInput, setAddColInput] = useState('');

  // Visual builder state — initialized from saved visualQuery, legacy ruleGroups, or parsed rawKql.
  const [visualQuery, setVisualQuery] = useState<VisualQuery>(() => {
    if (initial?.visualQuery) {
      // A stored visualQuery can go stale relative to rawKql (e.g. a rule saved before a parser
      // fix shipped) — see isVisualQueryStale for the detection rationale.
      if (initial.rawKql && initialParsed) {
        const stale = isVisualQueryStale({
          storedVisualQuery: initial.visualQuery,
          storedRawKql: initial.rawKql,
          scope: {
            level: scopeLevel,
            ...(scopeSubscriptions.length ? { subscriptions: scopeSubscriptions } : {}),
            ...(scopeManagementGroups.length ? { managementGroups: scopeManagementGroups } : {}),
          },
          resourceTypes: resourceTypes.split(',').map(t => t.trim()).filter(Boolean),
          projectColumns,
        });
        if (stale) return initialParsed.visualQuery;
      }
      return initial.visualQuery;
    }
    if (initial?.conditionGroups?.length || initial?.conditions?.length) {
      return legacyToVisualQuery(initial.conditionGroups ?? [], initial.conditions ?? []);
    }
    if (initialParsed) return initialParsed.visualQuery;
    return defaultVisualQuery();
  });

  // Applies-to state (spec 031) — undefined means "off", i.e. this rule is measured against every
  // resource in scope, exactly as before this field existed. No legacy source to migrate from
  // (the field is brand new), so unlike visualQuery above this is a plain pass-through.
  const [appliesTo, setAppliesTo] = useState<VisualQuery | undefined>(initial?.appliesTo);

  // Graph query state (spec 032) — only meaningful when isGraphBackend. Starts at a sane default
  // for a brand-new Directory rule (users, no filter) rather than undefined, since GraphRuleEditor
  // needs a real GraphQuery to render, unlike appliesTo above which has a real "off" state.
  const [graphQuery, setGraphQuery] = useState<GraphQuery>(initial?.graphQuery ?? { path: 'users' });

  // Log Analytics query state (spec 036) — only meaningful when isLogAnalyticsBackend. Same
  // needs-a-real-default reasoning as graphQuery above; 30 days matches the common "last 30 days"
  // framing and is the same default the test fixtures use.
  const [logsQuery, setLogsQuery] = useState<LogAnalyticsQuery>(initial?.logsQuery ?? { kql: '', timeWindowDays: 30 });

  // ── KQL pane state ──────────────────────────────────────────────────────────
  const kqlDriver = useRef<'gui' | 'kql'>('gui');
  const [kqlText, setKqlText] = useState(() => {
    const raw = isBuiltinCheck ? (kqlQuery ?? '') : (initial?.rawKql ?? '');
    // Mirrors the "Builder → KQL" memo below exactly. A mount that starts in edit mode (e.g. a
    // ?edit=true deep link) would otherwise have that memo rewrite this via a post-mount effect —
    // which dirty-tracking would see as a change nobody made.
    if (isReadOnly && raw) return raw;
    return buildQueryFromVisual(visualQuery, {
      scope: {
        level: scopeLevel,
        ...(scopeSubscriptions.length ? { subscriptions: scopeSubscriptions } : {}),
        ...(scopeManagementGroups.length ? { managementGroups: scopeManagementGroups } : {}),
      },
      resourceTypes: resourceTypes.split(',').map(t => t.trim()).filter(Boolean),
      projectColumns,
    });
  });
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);

  // ── Validation state ────────────────────────────────────────────────────────
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<ValidateResult | { error: string } | null>(null);

  const specificTypes = resourceTypes.split(',').map(t => t.trim()).filter(t => t && t !== '*');
  const allFields = [...new Set([...ARG_BASE_FIELDS, ...fields])];

  // Builder → KQL: re-generate whenever builder state or target changes.
  const kqlFromGui = useMemo(() => {
    // In read-only mode with explicit rawKql, show that verbatim (don't re-derive from parsed visual)
    if (isReadOnly && kqlText) return kqlText;
    return buildQueryFromVisual(visualQuery, {
      scope: {
        level: scopeLevel,
        ...(scopeSubscriptions.length ? { subscriptions: scopeSubscriptions } : {}),
        ...(scopeManagementGroups.length ? { managementGroups: scopeManagementGroups } : {}),
      },
      resourceTypes: resourceTypes.split(',').map(t => t.trim()).filter(Boolean),
      projectColumns,
    });
  }, [isReadOnly, kqlText, visualQuery, scopeLevel, scopeSubscriptions, scopeManagementGroups, resourceTypes, projectColumns]);

  // GUI → KQL pane
  useEffect(() => {
    if (kqlDriver.current === 'gui') setKqlText(kqlFromGui);
  }, [kqlFromGui]);

  // KQL pane → builder + scope/types/columns (debounced, fully bidirectional).
  // parseKqlToVisualQuery understands every pattern buildQueryFromVisual emits:
  // all 8 stage types, all 25 visual operators, | where grouping, resource type / scope clauses.
  // Warnings are only raised for patterns the parser genuinely cannot map (complex sub-expressions,
  // unknown pipe types not in the 8 supported stages).
  useEffect(() => {
    if (kqlDriver.current !== 'kql' || isReadOnly) return;
    const t = setTimeout(() => {
      const parsed = parseKqlToVisualQuery(kqlText);
      setScopeLevel(parsed.scope.level);
      if (parsed.resourceTypes.length) setResourceTypes(parsed.resourceTypes.join(', '));
      if (parsed.projectColumns.length) setProjectColumns(parsed.projectColumns);
      setParseWarnings(parsed.warnings);
      setVisualQuery(parsed.visualQuery);
    }, 400);
    return () => clearTimeout(t);
  }, [kqlText, isBuiltinCheck]);

  // Auto-populate known ARG fields when scope level changes to a container type. `fields` is also
  // set asynchronously elsewhere by a live schema fetch, so it's real state, not render-derivable.
  useEffect(() => {
    const containerFields = CONTAINER_FIELDS[scopeLevel];
    if (containerFields) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFields(containerFields);
      setFieldsStatus(`${containerFields.length} fields available (ARG ResourceContainers schema)`);
    } else {
      setFields([]);
      setFieldsStatus(null);
    }
  }, [scopeLevel]);

  function handleKqlChange(val: string) {
    kqlDriver.current = 'kql';
    setKqlText(val);
    setParseWarnings([]);
    setValidateResult(null);
  }

  function guiSet<T>(setter: React.Dispatch<React.SetStateAction<T>>) {
    return (val: T | ((prev: T) => T)) => {
      kqlDriver.current = 'gui';
      setter(val as T);
    };
  }

  async function handleValidate() {
    if (!kqlText.trim()) return;
    setValidating(true);
    setValidateResult(null);
    try {
      const res = await fetch('/api/rules/validate-kql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kql: kqlText }),
      });
      const data = await res.json() as ValidateResult | { error: string };
      setValidateResult(data);
    } catch (e) {
      setValidateResult({ error: String(e) });
    } finally { setValidating(false); }
  }

  async function fetchFieldsForTypes() {
    const isAll = specificTypes.length === 0;
    const typesToFetch = isAll ? COMMON_RESOURCE_TYPES_LIST : specificTypes;
    setFetchingFields(true); setFieldsStatus(null);
    try {
      const results = await Promise.all(
        typesToFetch.map(type =>
          fetch(`/api/resources/properties?type=${encodeURIComponent(type)}`)
            .then(async r => ({
              outcome: classifySchemaStatus(r.ok, r.status),
              fields: r.ok ? (await r.json() as { fields: string[]; source: string }) : null,
            }))
            .catch(() => ({ outcome: 'unavailable' as const, fields: null })),
        ),
      );
      const loadedFields = [...new Set(results.flatMap(r => r.fields?.fields ?? []))].sort();
      setFields(loadedFields);
      if (loadedFields.length === 0 && results.some(r => r.outcome === 'unavailable')) {
        setFieldsStatus('Could not load property schema from Azure. Check the RuleBeat server logs for details, then try again.');
      } else if (loadedFields.length === 0) {
        setFieldsStatus(isAll
          ? 'No fields returned. ARM credentials may be unavailable'
          : `No property schema available for "${specificTypes.join(', ')}". Third-party providers do not expose ARM aliases`);
      } else {
        const sources = results.flatMap(r => r.fields ? [r.fields.source] : []);
        const sourceLabel = sources.includes('arm') ? 'fresh from ARM' : 'cached';
        setFieldsStatus(isAll
          ? `Loaded ${loadedFields.length} fields from ${typesToFetch.length} common resource types (${sourceLabel})`
          : `Loaded ${loadedFields.length} fields (${sourceLabel})`);
      }
    } catch (err) {
      setFieldsStatus(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally { setFetchingFields(false); }
  }

  // ── Dirty tracking ────────────────────────────────────────────────────────
  // Diffed against a baseline rather than marked imperatively, so editing a field and then
  // reverting it clears the flag again instead of leaving Save stuck active. Uses the generated
  // KQL string (kqlFromGui) rather than the raw visualQuery object — the parser assigns every
  // condition/group/stage a fresh random id on every parse, so typing in the KQL pane and then
  // undoing it would otherwise leave visualQuery permanently different by id alone, even though
  // the query itself is byte-for-byte back to what it was.
  const currentSnapshot = useMemo(() => JSON.stringify({
    name, description, category, severity, enabled, tags,
    scopeLevel, scopeSubscriptions, scopeManagementGroups, resourceTypes, projectColumns,
    kql: kqlFromGui,
    appliesTo,
    graphQuery,
    logsQuery,
  }), [name, description, category, severity, enabled, tags, scopeLevel, scopeSubscriptions, scopeManagementGroups, resourceTypes, projectColumns, kqlFromGui, appliesTo, graphQuery, logsQuery]);
  const [baselineSnapshot, setBaselineSnapshot] = useState(currentSnapshot);
  const dirty = currentSnapshot !== baselineSnapshot;

  async function save() {
    if (!name.trim()) return alert('Name is required');
    // spec 044: the payload sent below must use this same value, not the raw `visualQuery` state —
    // that state only syncs from kqlText after a 400ms debounce (see kqlDriver above) and can still
    // be stale at the moment Save is clicked, even though this fresh re-parse (and therefore the
    // validation gate right below) already sees the real, current filter.
    let effectiveVisualQuery = visualQuery;
    if (!isBuiltinCheck && !usesDedicatedEditor) {
      // RB-RM-004: validate real compilation, not field non-emptiness (the old isRealCondition
      // check) — a condition can reference an unwritable field or carry an empty value list and
      // still look "filled in". When raw KQL is the driving surface, re-parse kqlText fresh rather
      // than trusting visualQuery, which only syncs from it after a 400ms debounce (see kqlDriver
      // above) and can still be stale at the moment Save is clicked.
      effectiveVisualQuery = kqlDriver.current === 'kql'
        ? parseKqlToVisualQuery(kqlText).visualQuery
        : visualQuery;
      if (!hasCompilableFilter(effectiveVisualQuery)) {
        return alert('Add at least one condition in the builder, or write a KQL query with a real filter in the editor above.');
      }
    }
    if (isGraphBackend && graphQuery.expand) {
      const { arrayField, dateField, itemIdField, resourceType, bands } = graphQuery.expand;
      if (!arrayField.trim() || !dateField.trim() || !itemIdField.trim() || !resourceType.trim() || bands.length === 0) {
        return alert('Flag expiring items needs an array field, a date field, an item id field, a label, and at least one severity band.');
      }
    }
    if (isLogAnalyticsBackend && !logsQuery.kql.trim()) {
      return alert('A Log Analytics rule needs a KQL query.');
    }
    setSaving(true);
    const scopeObj = {
      level: scopeLevel,
      ...(scopeSubscriptions.length ? { subscriptions: scopeSubscriptions } : {}),
      ...(scopeManagementGroups.length ? { managementGroups: scopeManagementGroups } : {}),
    };
    const resTypes = resourceTypes.split(',').map(t => t.trim()).filter(Boolean);
    const dedicated = deriveDedicatedEditorFields(queryBackend, {
      visualQuery: effectiveVisualQuery, appliesTo, rawKql: kqlText, graphQuery, logsQuery,
    });
    const payload = {
      name: name.trim(), description: description.trim(), category, severity, enabled, tags,
      queryBackend,
      scope: scopeObj,
      resourceTypes: resTypes,
      conditions: [],
      conditionGroups: undefined,
      projectColumns,
      visualQuery: dedicated.visualQuery,
      appliesTo: dedicated.appliesTo,
      rawKql: dedicated.rawKql,
      graphQuery: dedicated.graphQuery,
      logsQuery: dedicated.logsQuery,
    };
    try {
      const res = initial?.id
        ? await fetch(`/api/rules/${encodeURIComponent(initial.id)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, id: initial.id }),
        })
        : await fetch('/api/rules', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        alert(body?.error ?? 'Failed to save rule');
        return;
      }
      setBaselineSnapshot(currentSnapshot);
      if (initial?.id) {
        // Editing an existing rule: stay on the page (matches Duplicate/Cancel, which never
        // navigate either) and just pick up anything the save changed server-side.
        router.refresh();
      } else {
        // Same reasoning as the edit branch above: the Library page a plain back-navigation lands
        // on can be served from Next's router cache, predating this rule's creation.
        router.back();
        router.refresh();
      }
    } finally { setSaving(false); }
  }

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);
  // No deps: re-runs every render so the ref always calls the save() closure over the latest
  // field values, never one captured back when dirty/saving last changed.
  useEffect(() => {
    if (saveHandleRef) saveHandleRef.current = () => { void save(); };
  });

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      {/* Details/target on the left and the query builder on the right, wide enough apart
          that a large screen isn't mostly blank. The sidebar sticks while the (usually much
          taller) query/conditions column scrolls, so Name/Category/Enabled etc. never need
          a scroll to reach — they used to sit below the whole KQL card. Below `lg` this
          collapses to one column, sidebar first, same as before. */}
      <div className="space-y-6 lg:grid lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start lg:gap-6 lg:space-y-0">

        {/* ── Sidebar: Rule Details ─────────────────────────────────────────── */}
        <div className="space-y-6 lg:sticky lg:top-20">

          {/* ── Rule Details ──────────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Rule Details</CardTitle>
              <label className="flex items-center gap-2 shrink-0">
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={operationalReadOnly}
                  title={operationalReadOnly ? 'Read-only access' : enabled ? 'Disable rule' : 'Enable rule'}
                />
                <span className="text-xs text-ink-2">Enabled</span>
              </label>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="mb-1">Name *</Label>
                <Input value={name} onChange={e => { guiSet(setName)(e.target.value); }} placeholder="e.g. Required tag: Environment" disabled={isReadOnly} />
              </div>
              <div>
                <Label className="mb-1">Description</Label>
                {isBuiltinCheck ? (() => {
                  const { text: mainText, url: learnUrl } = splitLearnMore(description);
                  return (
                    <div className="space-y-2 border border-border bg-surface-sunken px-3 py-2.5">
                      <p className="text-sm leading-relaxed text-ink-2">{mainText}</p>
                      {learnUrl && (
                        <a href={learnUrl} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-medium text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink">
                          Microsoft Docs
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                  );
                })() : (
                  <Textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="What does this policy check?"
                    rows={3}
                    className="resize-none"
                  />
                )}
              </div>
              {initial?.id && (() => {
                const isAprl = initial.pack === 'aprl-v2';
                const resourceType = initial.resourceTypes?.[0];
                const aprlPath = resourceType?.replace(/^microsoft\./i, '');
                const aprlUrl = aprlPath
                  ? `https://azure.github.io/Azure-Proactive-Resiliency-Library-v2/azure-resources/${aprlPath}/`
                  : 'https://azure.github.io/Azure-Proactive-Resiliency-Library-v2/';
                return (
                  <div>
                    <Label className="mb-1">Rule ID</Label>
                    <div className="flex items-center gap-2 border border-border bg-surface-sunken px-3 py-2">
                      <span className="flex-1 select-all font-mono text-xs text-ink">{initial.id}</span>
                      <CopyButton text={initial.id} />
                      {isAprl && (
                        <a href={aprlUrl} target="_blank" rel="noopener noreferrer"
                          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink">
                          View in APRL
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })()}
              {(typeChip || checksChip) && (
                <div className="grid grid-cols-2 gap-3">
                  {typeChip && (
                    <div>
                      <Label className="mb-1">Origin</Label>
                      <span
                        title={typeChip.label === 'Built-in' ? 'Built-in, read-only' : typeChip.label}
                        className="inline-flex w-fit items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2"
                      >
                        {typeChip.icon === 'sparkles' ? <Sparkles className="size-3 shrink-0" /> : typeChip.icon === 'lock' ? <Lock className="size-3 shrink-0" /> : null}
                        {typeChip.label}
                      </span>
                    </div>
                  )}
                  {checksChip && (
                    <div>
                      <Label className="mb-1">Checks</Label>
                      <span
                        title={`${checksChip.label}, can't be changed after creation`}
                        className="inline-flex w-fit items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2"
                      >
                        <Lock className="size-3 shrink-0" />
                        {checksChip.label}
                      </span>
                    </div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="mb-1">Category</Label>
                  <Select
                    value={category}
                    onValueChange={v => { guiSet(setCategory)(v as ModuleCategory); }}
                    disabled={isReadOnly}
                    options={categoryOptions.map(c => ({ value: c, label: c }))}
                    aria-label="Category"
                  />
                </div>
                <div>
                  <Label className="mb-1">Severity</Label>
                  <Select
                    value={severity}
                    onValueChange={v => { guiSet(setSeverity)(v as Severity); }}
                    disabled={isReadOnly}
                    options={SEVERITY_OPTIONS}
                    aria-label="Severity"
                  />
                </div>
              </div>
              <div>
                <Label className="mb-1">Tags</Label>
                <TagPicker tags={tags} allTags={allTags} onChange={setTags} disabled={operationalReadOnly} lockedTags={lockedTags} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Main: Query Target + Output Columns + KQL Pane + Conditions ─────── */}
        <div className="min-w-0 space-y-6">
          {isGraphBackend ? (
            <GraphRuleEditor
              value={graphQuery}
              onChange={setGraphQuery}
              readOnly={graphQueryReadOnly}
            />
          ) : isLogAnalyticsBackend ? (
            <LogAnalyticsRuleEditor
              value={logsQuery}
              onChange={setLogsQuery}
              readOnly={graphQueryReadOnly}
            />
          ) : (
            <>

          {/* ── KQL Pane ──────────────────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2.5 min-w-0">
                <CardTitle>Detection Query (KQL)</CardTitle>
                {!isReadOnly && (
                  <span className="label-grid shrink-0 whitespace-nowrap border border-border bg-surface-sunken px-1.5 py-0.5">Editable</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <CopyButton text={kqlText} />
                <Button variant="outline" size="sm" disabled={validating || !kqlText.trim()} onClick={() => { void handleValidate(); }}>
                  <Play className="h-3.5 w-3.5" />
                  {validating ? 'Testing…' : 'Validate'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {!isReadOnly && (
                <p className="text-[13px] text-ink-2">
                  Generated from the Conditions builder below. Edit directly for advanced scenarios not expressible in the builder: joins, <span className="font-mono text-xs">mv-expand</span>, <span className="font-mono text-xs">let</span> statements.
                </p>
              )}
              {/* The query used to sit in a hardcoded slate-950 panel whichever theme was on,
                  so in light mode it was a black card dropped into a white page. It is a sunken
                  surface now and follows the theme like everything else. */}
              {isReadOnly ? (
                <CodeBlock code={kqlText} copyable={false} />
              ) : (
                <Textarea
                  value={kqlText}
                  onChange={e => handleKqlChange(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="resize-y bg-surface-sunken px-3 py-2.5 font-mono text-xs leading-relaxed"
                />
              )}

              {!isReadOnly && (scopeSubscriptions.length > 0 || scopeManagementGroups.length > 0) && (
                <Callout tone="info" title="Execution scope restricted">
                  <p>
                    {[
                      ...scopeManagementGroups.map(id => scopeNames[id] ?? id),
                      ...scopeSubscriptions.map(id => scopeNames[id] ?? id),
                    ].join(', ')}
                  </p>
                </Callout>
              )}

              {parseWarnings.length > 0 && (
                <Callout tone="warn">
                  <p>Some parts of your KQL couldn&apos;t be reflected in the builder. They&apos;ll still run correctly in Azure.</p>
                  {parseWarnings.map((w, i) => (
                    <p key={i} className="font-mono text-ink-2">{w}</p>
                  ))}
                </Callout>
              )}

              {validateResult && (
                'error' in validateResult ? (
                  <Callout tone="error" title="Query error">
                    <p className="font-mono">{validateResult.error}</p>
                  </Callout>
                ) : (
                  <CalloutPanel
                    tone="success"
                    title={`Valid. Matched ${validateResult.count} resource${validateResult.count !== 1 ? 's' : ''} (showing up to 5)`}
                  >
                    {validateResult.samples.length > 0 && (
                      // Sideways only, and no height cap. Five rows never need one.
                      <div className="scroll-x">
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-current/15">
                              <th className="label-grid whitespace-nowrap px-3 py-1.5 text-left">Name</th>
                              <th className="label-grid whitespace-nowrap px-3 py-1.5 text-left">Type</th>
                              <th className="label-grid whitespace-nowrap px-3 py-1.5 text-left">Resource group</th>
                              <th className="label-grid whitespace-nowrap px-3 py-1.5 text-left">Subscription ID</th>
                            </tr>
                          </thead>
                          <tbody>
                            {validateResult.samples.map((s, i) => (
                              <tr key={i} className="border-b border-current/10 last:border-0">
                                <td className="max-w-[160px] truncate px-3 py-1.5 font-medium text-ink">{s.name}</td>
                                <td className="max-w-[200px] truncate px-3 py-1.5 font-mono text-xs text-ink">{s.type}</td>
                                <td className="max-w-[140px] truncate px-3 py-1.5 text-ink">{s.resourceGroup}</td>
                                <td className="px-3 py-1.5 font-mono text-xs text-ink">{s.subscriptionId}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CalloutPanel>
                )
              )}
            </CardContent>
          </Card>

          {/* ── Query Target ──────────────────────────────────────────────────── */}
          <div className={isReadOnly ? 'pointer-events-none opacity-75' : ''}>
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm">Query Target</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="mb-1">ARG table</Label>
                    <Select
                      value={scopeLevel}
                      onValueChange={v => { guiSet(setScopeLevel)(v as RuleScope['level']); }}
                      disabled={isReadOnly}
                      options={ARG_TABLE_OPTIONS}
                      aria-label="ARG table"
                    />
                  </div>
                  {scopeLevel === 'resource' && (
                    <div>
                      <Label className="mb-1">Resource types</Label>
                      <ResourceTypeInput value={resourceTypes} onChange={v => { guiSet(setResourceTypes)(v); }} readOnly={isReadOnly} />
                    </div>
                  )}
                </div>
                <div>
                  <Label className="mb-1.5">Scope</Label>
                  <ScopeTreePicker
                    subscriptions={scopeSubscriptions}
                    managementGroups={scopeManagementGroups}
                    onChange={({ subscriptions: subs, managementGroups: mgs }) => {
                      guiSet(setScopeSubscriptions)(subs);
                      guiSet(setScopeManagementGroups)(mgs);
                    }}
                    onNamesReady={setScopeNames}
                  />
                </div>
                {!isReadOnly && (
                  <p className="text-xs text-ink-muted">Leave at &quot;Entire tenant&quot; to scan all subscriptions your credentials can access.</p>
                )}
                {!isReadOnly && (() => {
                  // A load that failed is the only state here worth colouring. "Loaded 412 fields"
                  // is ordinary confirmation, and painting it green put a permanent success colour
                  // on a form that had done nothing noteworthy.
                  const failed = !!fieldsStatus && (fieldsStatus.startsWith('No ') || fieldsStatus.startsWith('Failed') || fieldsStatus.startsWith('Could not load'));
                  return (
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <Label>Property schema</Label>
                        {scopeLevel === 'resource' && (
                          <Button variant="outline" size="xs" onClick={fetchFieldsForTypes} disabled={fetchingFields}>
                            {fetchingFields ? 'Loading…' : specificTypes.length === 0 ? 'Fetch common fields' : 'Fetch fields'}
                          </Button>
                        )}
                      </div>
                      <p className={failed ? 'text-xs text-sev-critical' : 'text-xs text-ink-muted'}>
                        {scopeLevel !== 'resource'
                          ? fieldsStatus
                          : fieldsStatus
                            ? fieldsStatus
                            : specificTypes.length === 0
                              ? <>Click <span className="font-medium text-ink">&quot;Fetch common fields&quot;</span> to load properties from {COMMON_RESOURCE_TYPES_LIST.length} common Azure resource types.</>
                              : `Click "Fetch fields" to load properties for ${specificTypes.join(', ')}.`
                        }
                      </p>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          </div>

          {/* ── Output Columns ────────────────────────────────────────────────── */}
          {(!isReadOnly || projectColumnsKnown) && (
            <div className={isReadOnly ? 'pointer-events-none opacity-75' : ''}>
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-1.5">
                  <CardTitle className="text-sm">Output Columns</CardTitle>
                  <span title="Columns returned by the query and available in findings. Matches the | project clause in KQL."><HelpCircle className="size-3.5 text-ink-faint" /></span>
                </div>
                <p className="mt-1 text-[13px] text-ink-2">
                  {isReadOnly
                    ? <>Properties included in findings, from the <code className="bg-surface-sunken px-1 font-mono text-xs text-ink-2">| project</code> clause in the KQL above.</>
                    : <>Choose which properties to include in findings. The <code className="bg-surface-sunken px-1 font-mono text-xs text-ink-2">| project</code> clause in the KQL above reflects these.</>}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {projectColumns.map(col => (
                    <span key={col} className="inline-flex items-center gap-1 bg-surface-sunken px-2 py-0.5 font-mono text-xs text-ink-2">
                      {col}
                      {!isReadOnly && (
                        <button
                          onClick={() => guiSet(setProjectColumns)(projectColumns.filter(c => c !== col))}
                          className="ml-0.5 text-ink-faint transition-colors hover:text-ink"
                          title={`Remove ${col}`}
                        >×</button>
                      )}
                    </span>
                  ))}
                </div>
                {!isReadOnly && (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <FieldCombobox
                          value={addColInput}
                          onChange={setAddColInput}
                          onSelect={col => {
                            if (col && !projectColumns.includes(col)) {
                              guiSet(setProjectColumns)([...projectColumns, col]);
                            }
                            setAddColInput('');
                          }}
                          options={[
                            'id', 'name', 'type', 'location', 'resourceGroup', 'subscriptionId',
                            'tags', 'properties', 'sku', 'kind', 'identity', 'zones', 'plan',
                            ...fields,
                          ].filter((v, i, a) => a.indexOf(v) === i && !projectColumns.includes(v))}
                          placeholder="Search and select a column to add…"
                          className={inputCls}
                        />
                      </div>
                    </div>
                    <button
                      className="text-xs font-medium text-ink-2 underline-offset-4 transition-colors hover:text-ink hover:underline"
                      onClick={() => guiSet(setProjectColumns)([...DEFAULT_PROJECT_COLUMNS])}
                    >
                      Reset to defaults
                    </button>
                  </>
                )}
              </CardContent>
            </Card>
            </div>
          )}

          {/* ── Applies to (spec 031) ────────────────────────────────────────────── */}
          <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-1.5 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <CardTitle className="text-sm">Applies to</CardTitle>
                    {!isReadOnly && (
                      <span title="Optional. Define the population this rule is measured against — for example, only VMs tagged production. Posture then reads as 'X of Y' instead of a bare finding count. Leave this off to measure against every resource in scope, as today.">
                        <HelpCircle className="size-3.5 text-ink-faint" />
                      </span>
                    )}
                  </div>
                  {!isReadOnly && (
                    <Switch
                      checked={appliesTo !== undefined}
                      onCheckedChange={(checked) => setAppliesTo(checked ? defaultVisualQuery() : undefined)}
                      title={appliesTo !== undefined ? 'Measure against every resource in scope instead' : 'Measure against a defined subset instead'}
                    />
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {appliesTo !== undefined ? (
                  <VisualQueryBuilder
                    query={appliesTo}
                    onChange={setAppliesTo}
                    fields={allFields}
                    readOnly={isReadOnly}
                    heading="Applies to"
                  />
                ) : (
                  <p className="py-1 text-xs text-ink-2">
                    {isReadOnly
                      ? 'This rule is measured against every resource in scope.'
                      : 'Off — this rule is measured against every resource in scope. Turn on to track posture against a defined subset instead.'}
                  </p>
                )}
              </CardContent>
            </Card>

          {/* ── Violates when ─────────────────────────────────────────────────── */}
          {(() => {
            // In read-only mode, check whether the parsed visual query has any visible filter conditions.
            // APRL and complex rules produce only advanced stages (join/expand/aggregate) which would
            // all render as AdvancedPassthroughBlock — not useful to show. If there are no filter
            // conditions, show a brief note instead of a wall of "too complex" blocks.
            const hasFilterConditions = !isReadOnly || visualQuery.stages.some(
              s => s.type === 'filter' && (s as FilterStage).groups.some(g => g.conditions.some(isRealCondition))
            );
            return (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <CardTitle className="text-sm">Violates when</CardTitle>
                    {!isReadOnly && (
                      <span title="Build the violation filter visually. Each condition becomes a | where clause. Resources matching your conditions will be flagged as findings.">
                        <HelpCircle className="size-3.5 text-ink-faint" />
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {isReadOnly && !hasFilterConditions ? (
                    <p className="py-1 text-xs text-ink-2">
                      This rule uses advanced KQL features (joins, aggregations, or expansions) that are not representable in the visual builder. The full logic is shown in the KQL query above.
                    </p>
                  ) : (
                    <VisualQueryBuilder
                      query={visualQuery}
                      onChange={q => { kqlDriver.current = 'gui'; setVisualQuery(q); }}
                      fields={allFields}
                      readOnly={isReadOnly}
                      heading="Violates when"
                    />
                  )}
                </CardContent>
              </Card>
            );
          })()}
            </>
          )}
        </div>
      </div>

      {/* ── Actions ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pb-6">
        {/* When saveHandleRef is set, the embedding page renders Save itself (beside Edit) —
            this bar would otherwise duplicate it. */}
        {!saveHandleRef && (!isReadOnly || !operationalReadOnly) && (
          <Button onClick={save} disabled={saving || (!!initial?.id && !dirty)}>
            {saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Create Rule'}
          </Button>
        )}
        <Button variant="ghost" onClick={() => router.back()}>
          Back
        </Button>
      </div>
    </div>
  );
}
