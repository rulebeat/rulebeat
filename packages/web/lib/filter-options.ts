/**
 * The one options read behind the shared filter component (#388): everything the Scope picker, the Rule source
 * control, the Rule and Tags pickers and the column funnels offer, in one answer. The server builds it
 * (`lib/db/filter-options.ts`, `GET /api/filters/options`); the Scans toolbar draws it now, and the dashboard bar
 * and the widget Filters panel are built to take the same value. Client-safe: no Node, no database.
 */
import type { Severity } from './types';
import type { ExplorerCategory } from './view-response';
import type { ScopeOptions } from './scope-options';
import type { ScopeFunnelPlacements } from './scope-funnels';
import { COMMUNITY_SOURCE, CUSTOM_SOURCE } from './filter-states';

export { packSourceLabel, type PackManifestLabels } from './pack-labels';

export interface SourceOption { value: string; label: string }

/** A rule on offer in the Rule picker. A disabled or retired rule is still listed, and says so. */
export interface RuleOption {
  id: string;
  name: string;
  category: string;
  disabled: boolean;
  retired: boolean;
}

export interface FilterOptions {
  categories: ExplorerCategory[];
  /** Each pack some built-in rule carries, then Community and Custom. */
  sources: SourceOption[];
  /** Every tag on any rule on the install. */
  tags: string[];
  /** In ramp order, most severe first. */
  severities: Severity[];
  /** Every rule on the install, whatever the viewer's Scope, by name. Personal rules are not rules of the install. */
  rules: RuleOption[];
  scopes: ScopeOptions;
  placements: ScopeFunnelPlacements;
}

/** The Community and Custom sources, which end the list. */
export const FIXED_SOURCES: readonly SourceOption[] = [
  { value: COMMUNITY_SOURCE, label: 'Community' },
  { value: CUSTOM_SOURCE, label: 'Custom' },
];

/** What a rule reads as in the Rule picker: its name, with Retired and Disabled said so a rule is never listed as if it ran. */
export function ruleOptionLabel(rule: Pick<RuleOption, 'name' | 'disabled' | 'retired'>): string {
  const notes = [rule.retired ? 'Retired' : null, rule.disabled ? 'Disabled' : null].filter(Boolean);
  return notes.length > 0 ? `${rule.name} (${notes.join(', ')})` : rule.name;
}
