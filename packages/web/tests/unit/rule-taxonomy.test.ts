/**
 * Spec 029 — canDuplicateRule() is the single shared predicate behind both halves of the
 * Duplicate/copyFrom guard: rule-detail-client.tsx (hides the Duplicate button) and
 * rules/new/page.tsx (falls back to a blank new-rule form for a `?copyFrom=` of an
 * un-authorable rule). Spec 032 made Directory configuration (queryBackend:
 * 'microsoft-graph') authorable too, and spec 036 did the same for Log Analytics — every
 * backend now has a real editor, so every backend is duplicable.
 */
import { describe, expect, it } from 'vitest';
import { canDuplicateRule } from '@/lib/rule-taxonomy';

describe('canDuplicateRule (spec 029)', () => {
  it('allows duplicating a resource-graph rule', () => {
    expect(canDuplicateRule({ queryBackend: 'resource-graph' })).toBe(true);
  });

  it('defaults to true when queryBackend is undefined (legacy rows predate the field)', () => {
    expect(canDuplicateRule({ queryBackend: undefined })).toBe(true);
  });

  it('allows duplicating a microsoft-graph rule (spec 032)', () => {
    expect(canDuplicateRule({ queryBackend: 'microsoft-graph' })).toBe(true);
  });

  it('allows duplicating a log-analytics rule (spec 036)', () => {
    expect(canDuplicateRule({ queryBackend: 'log-analytics' })).toBe(true);
  });
});
