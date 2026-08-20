/**
 * Architecture test: every dashboard widget uses the shared unavailable-state contract.
 *
 * Spec 010 replaced each widget's own `T | null` fetch + ad-hoc empty-state collapse with a shared
 * `useWidgetFetch` hook and `WidgetUnavailable` component, so a failed fetch renders "Couldn't load
 * this widget" instead of being indistinguishable from a genuinely empty result. This reads the
 * widget source files off disk (same style as qa-plan-doc-drift.test.ts) and fails the build the
 * moment a widget stops importing either piece — including a brand-new widget added later that
 * never adopted the pattern in the first place.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'components', 'dashboard', 'widgets');

const widgetFiles = readdirSync(WIDGETS_DIR)
  .filter(name => name.endsWith('-widget.tsx'));

describe('every dashboard widget uses the shared unavailable-state contract', () => {
  it('found widget files at all (guards against this suite silently testing nothing)', () => {
    expect(widgetFiles.length).toBeGreaterThanOrEqual(11);
  });

  it.each(widgetFiles)('%s imports useWidgetFetch', (file) => {
    const source = readFileSync(join(WIDGETS_DIR, file), 'utf8');
    expect(source).toContain("from '@/lib/hooks/use-widget-fetch'");
  });

  it.each(widgetFiles)('%s imports WidgetUnavailable', (file) => {
    const source = readFileSync(join(WIDGETS_DIR, file), 'utf8');
    expect(source).toContain("from '@/components/dashboard/widgets/widget-unavailable'");
  });

  it.each(widgetFiles)('%s no longer imports fetchJson directly', (file) => {
    const source = readFileSync(join(WIDGETS_DIR, file), 'utf8');
    expect(source).not.toContain("from '@/lib/fetch-json'");
  });
});
