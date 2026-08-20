/**
 * Architecture test for spec 002: type hierarchy is carried by weight, not by widening
 * `ink-muted`/`ink-faint` into a catch-all "make this text quieter" move.
 *
 * Same shape as azure-credential-chokepoint.test.ts — grep source files off disk for a convention
 * the type system can't express. This is a floor, not a quality proof: see spec 002 §2 Risks — the
 * automated checks below catch gross backsliding (a stacked contradiction, raw counts moving the
 * wrong way, faint creeping into an unreviewed file), not whether an individual call site's role
 * was judged correctly. That judgment was reviewed manually, screen by screen, at build time.
 *
 * Also carries the type-floor enforcement (below), on the same file walker. The 12px floor
 * documented in docs/engineering/conventions/design-system.md had no code check at all before
 * this, which is how label-grid's 11px shipped without ever being named as an exception.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNED_DIRS = ['app', 'components'];

function findSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // `readdirSync` walks Next.js's literal `[id]` directories correctly; a glob-based sweep would
    // treat the brackets as a wildcard and skip every dynamic route.
    if (statSync(full).isDirectory()) found.push(...findSourceFiles(full));
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

const sourceFiles = SCANNED_DIRS
  .flatMap(d => findSourceFiles(join(WEB_ROOT, d)))
  .map(full => ({
    rel: relative(WEB_ROOT, full).split(sep).join('/'),
    lines: readFileSync(full, 'utf8').split('\n'),
  }));

/**
 * Hand-checked during spec 002 batch 4: every file with a remaining `text-ink-faint` call site,
 * verified one by one to be a placeholder/disabled state, a decorative icon, a deliberate status
 * ramp with its own defending comment (e.g. stepper.tsx's future-step badge,
 * coverage-freshness-widget.tsx's "never scanned" state), or the one standing severity-ramp
 * exception (severity-badge.tsx's info row — severity is out of scope per the spec's Frame). A
 * file not on this list gets none of that benefit of the doubt.
 */
const ALLOWED_FAINT_FILES = new Set([
  'app/(app)/dashboards/dashboards-gallery.tsx',
  'app/(app)/diagnostics/diagnostics-client.tsx',
  'app/(app)/library/library-client.tsx',
  'app/(app)/settings/users-section.tsx',
  'app/(app)/suppressions/suppressions-client.tsx',
  'components/dashboard/widget-config-panel.tsx',
  'components/dashboard/widget-wrapper.tsx',
  'components/dashboard/widgets/coverage-freshness-widget.tsx',
  'components/diagnostics/preflight-checks.tsx',
  'components/findings/findings-explorer-client.tsx',
  'components/findings/severity-badge.tsx',
  'components/modules/scans-client.tsx',
  // spec 029: the "Coming soon" tag on a not-yet-authorable Checks option — a disabled-state label.
  'components/rules/checks-picker-dialog.tsx',
  'components/rules/field-combobox.tsx',
  // spec 032: decorative HelpCircle glyphs beside the Filter and "Flag expiring items" labels.
  'components/rules/graph-rule-editor.tsx',
  // spec 036: decorative HelpCircle glyphs beside the "Time window" and "Dimension key field" labels.
  'components/rules/log-analytics-rule-editor.tsx',
  // spec 037: the "Delete" affordance on a saved-query row, hidden until hover — a disabled/hover-
  // reveal affordance, the same role as every other hover-only action already on this allowlist.
  'components/query/query-client.tsx',
  'components/rules/rule-form.tsx',
  'components/rules/scope-tree-picker.tsx',
  'components/rules/tag-picker.tsx',
  'components/rules/visual-query-builder.tsx',
  'components/ui/checklist-dropdown.tsx',
  'components/ui/dropdown-menu.tsx',
  'components/ui/input.tsx',
  'components/ui/select.tsx',
  'components/ui/stepper.tsx',
]);

/**
 * Coarse regression backstop, not a quality proof (spec 002 §2 Risks #1) — it only catches the raw
 * count moving the wrong way, nothing about whether existing sites are well-placed. Set from the
 * real count once all four batches landed (286 pre-sweep -> this). If a later change reverts one
 * of those batches, this cap moves down in the same commit rather than being left to silently pass
 * stale. Raised 149 -> 151 by spec 030: posture-ring-widget's "N not yet proven" callout and
 * scans-client's per-rule "N resources affected" span are both metadata/caption text, fitting the
 * role below. Raised 151 -> 152 by spec 031: scans-client's new "N of M affected" span (the
 * lastPopulationCount branch, for assert-shape rules) reuses the exact same numeral/caption styling
 * as the sibling span beside it, so it's the same role, not a new one. Raised 152 -> 154 by spec
 * 032: graph-rule-editor's empty-state caption ("No severity bands...") and its helper text
 * explaining band evaluation order are both metadata/helper text, not structural labels. Raised
 * 154 -> 156 by spec 033: the category/subscription scorecard widgets' new secondary "pct%" span
 * sitting under the passing/total headline is the same numeral/caption role as the "not yet
 * proven" span already counted above, not a structural label. Raised 156 -> 158 by spec 034: the
 * new activity-occurrences-widget's loading spinner and empty-state copy reuse the identical
 * text-ink-muted pattern every other widget file already carries (and was already counted in the
 * baseline) — a new widget, not a new role. Raised 158 -> 160 by spec 035: log-analytics-section's
 * card-header icon tint and its StatusDetail caption (workspace id + last-verified timestamp) are
 * line-for-line the same two call sites azure-connection-section already carries for the sibling
 * card above it — a new settings section reusing an existing role, not a new one. Raised 160 -> 161
 * by spec 036: log-analytics-rule-editor's sample-row preview labels each field name (e.g. "UserId:")
 * beside its value, the same caption-paired-with-value role as every other metadata/timestamp site
 * already counted above, not a structural label. Raised 161 -> 168 by spec 037: query-client.tsx's
 * 5 sites (saved-queries/history panel loading and empty states, the "shared" visibility marker
 * beside a saved query's name, and the run-count/timestamp caption on a history row) and
 * save-query-dialog.tsx's 2 sites (the dialog close icon's idle tint and the private/shared helper
 * caption beneath the visibility toggle) are the same loading/empty-state/caption/icon-tint roles
 * already covered above, not a new one. Raised 168 -> 169 by the query-run-history persistence
 * follow-up: query-client.tsx's History panel moved from client-side sessionStorage to a fetched,
 * server-backed list. It keeps its existing loading and empty-state sites but gains one net new
 * site, the run's row-count/timestamp caption, the same metadata-caption role already covered above.
 * Raised 169 -> 171 by spec 039 (dashboard denominator honesty):
 * subscription-scorecard-widget.tsx and trend-widget.tsx each gain one caption noting that a
 * per-subscription total still reflects the whole category's rule count, the same
 * helper/metadata-caption role, not a new one.
 */
const INK_MUTED_CEILING = 171;

describe('type hierarchy: ink-muted/ink-faint stay narrow, weight carries the rest (spec 002)', () => {
  it('found the source files at all (guards against this suite silently testing nothing)', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it('no call site stacks label-grid/label-grid-strong with an ink-muted or ink-2 colour class', () => {
    // label-grid already sets its own colour (ink-2) — stacking an ink class on top is either
    // redundant or silently fighting the utility. This is the contradiction spec 002's challenge
    // found in review, grounded directly in a test rather than left in prose.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      file.lines.forEach((line, i) => {
        if (/label-grid(-strong)?\b/.test(line) && /text-ink-(muted|2)\b/.test(line)) {
          offenders.push(`${file.rel}:${i + 1}`);
        }
      });
    }
    expect(offenders, [
      'These lines combine label-grid/label-grid-strong with text-ink-muted or text-ink-2.',
      'label-grid already sets ink-2 as its own colour — drop the extra colour class.',
    ].join(' ')).toEqual([]);
  });

  it('text-ink-muted stays at or below its post-sweep ceiling', () => {
    const total = sourceFiles.reduce(
      (n, f) => n + (f.lines.join('\n').match(/text-ink-muted/g)?.length ?? 0),
      0,
    );
    expect(total, [
      `text-ink-muted appears ${total} times, above the ceiling of ${INK_MUTED_CEILING} set after`,
      "spec 002's sweep. This is a backstop against backsliding into the generic \"make it quieter\"",
      "tier, not proof any one call site is well-placed — judge a new site against ink-muted's",
      'narrowed role (captions, timestamps, helper/metadata text only, not structural labels) before',
      'reaching for it.',
    ].join(' ')).toBeLessThanOrEqual(INK_MUTED_CEILING);
  });

  it('every text-ink-faint call site lives in a hand-checked file', () => {
    const offenders = sourceFiles
      .filter(f => !ALLOWED_FAINT_FILES.has(f.rel) && f.lines.some(l => /text-ink-faint\b/.test(l)))
      .map(f => f.rel);

    expect(offenders, [
      'These files use text-ink-faint but are not in the spec 002 hand-checked allowlist.',
      'ink-faint is reserved for placeholder/disabled states, decorative icons, a self-documented',
      'status ramp, or the standing severity-ramp exception — verify the new site actually fits one',
      'of those before adding it to ALLOWED_FAINT_FILES.',
    ].join(' ')).toEqual([]);
  });

  it('the faint allowlist is not vacuous (guards against this suite silently testing nothing)', () => {
    expect(ALLOWED_FAINT_FILES.size).toBeGreaterThan(10);
    const faintFilesFound = sourceFiles.filter(f => f.lines.some(l => /text-ink-faint\b/.test(l)));
    expect(faintFilesFound.length).toBeGreaterThan(0);
  });
});

/**
 * `label-grid`/`label-grid-strong` (app/globals.css) are the one documented, contained exception
 * to the 12px floor — verified deliberately at 11px in the 2026-08-10 design-system sweep. This
 * allowlist covers everything else pre-existing: non-linguistic icon glyphs (scope-tree-picker's
 * marker badges), and font-mono uppercase micro-labels that predate label-grid/label-grid-strong
 * existing as shared utilities (button.tsx's "grid" variant, visual-query-builder's condition
 * chips). Each entry names a specific file:line, not a pattern or a whole file, so a new sub-12px
 * site can never ride in silently on an existing one's exemption.
 */
const TYPE_FLOOR_ALLOWLIST = new Set([
  'components/rules/scope-tree-picker.tsx:15',
  'components/rules/scope-tree-picker.tsx:258',
  'components/rules/scope-tree-picker.tsx:262',
  'components/rules/scope-tree-picker.tsx:305',
  'components/rules/visual-query-builder.tsx:140',
  'components/rules/visual-query-builder.tsx:165',
  'components/rules/visual-query-builder.tsx:251',
  'components/ui/button.tsx:52',
]);

/** Tailwind's `text-[...]` arbitrary syntax is unambiguously font-size in this codebase (width/
 *  height arbitrary values use `w-[...]`/`h-[...]`, never `text-[...]`) — and a bare `fontSize:`
 *  style value (Recharts tick/legend props) is always px-equivalent, never a unitless multiplier
 *  the way `lineHeight` can be. Returns every sub-12px value found on the line, if any. */
function subFloorFontSizes(line: string): number[] {
  const sizes: number[] = [];
  for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) sizes.push(Number(m[1]));
  for (const m of line.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)) sizes.push(Number(m[1]));
  return sizes.filter(n => n < 12);
}

describe('type floor: text-xs (12px) is the minimum outside the named label-grid exception (spec 013)', () => {
  it('no call site uses a font-size below 12px that is not in TYPE_FLOOR_ALLOWLIST', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      file.lines.forEach((line, i) => {
        if (subFloorFontSizes(line).length > 0 && !TYPE_FLOOR_ALLOWLIST.has(`${file.rel}:${i + 1}`)) {
          offenders.push(`${file.rel}:${i + 1}`);
        }
      });
    }
    expect(offenders, [
      'These lines use a font-size below the 12px floor (text-xs) and are not in TYPE_FLOOR_ALLOWLIST.',
      'label-grid/label-grid-strong (11px, defined once in app/globals.css) are the one documented',
      'exception to the floor. Raise the size to 12px or larger, or, if this is a deliberate',
      'non-linguistic glyph (not copy a user reads as text), add its exact file:line to the allowlist.',
    ].join(' ')).toEqual([]);
  });

  it('the type-floor allowlist is not vacuous (guards against this suite silently testing nothing)', () => {
    expect(TYPE_FLOOR_ALLOWLIST.size).toBeGreaterThan(0);
    const matched = sourceFiles.some(file =>
      file.lines.some((line, i) => subFloorFontSizes(line).length > 0 && TYPE_FLOOR_ALLOWLIST.has(`${file.rel}:${i + 1}`)),
    );
    expect(matched).toBe(true);
  });
});
