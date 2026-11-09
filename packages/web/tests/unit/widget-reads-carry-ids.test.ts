/**
 * Architecture test (#375): every dashboard widget that reads a number or a list names its dashboard and its
 * widget, and sends the page's values and its own apart. A widget that merged its filters itself and sent the
 * result would leave the server nothing to add each place's held-back values to.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDGETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'components', 'dashboard', 'widgets');
const FILTERED_READS = /\/api\/widgets\/(summary|findings|top-rules|top-resources|advisories)\?/;

const readers = readdirSync(WIDGETS_DIR)
  .filter(name => name.endsWith('-widget.tsx'))
  .filter(name => FILTERED_READS.test(readFileSync(join(WIDGETS_DIR, name), 'utf8')));

describe('every widget that reads findings names its dashboard and widget', () => {
  it('found the widgets at all (guards against this suite silently testing nothing)', () => {
    expect(readers.length).toBeGreaterThanOrEqual(13);
  });

  it.each(readers)('%s builds its read with the dashboard and widget ids', (file) => {
    const source = readFileSync(join(WIDGETS_DIR, file), 'utf8');
    expect(source).toContain('buildWidgetReadParams(target,');
    expect(source).toContain('useWidgetReadTarget()');
  });

  it.each(readers)('%s does not send the merged filters', (file) => {
    const source = readFileSync(join(WIDGETS_DIR, file), 'utf8');
    expect(source).not.toContain('buildSummaryParams');
  });
});
