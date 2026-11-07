import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The five chart series tokens in app/globals.css, read from the stylesheet itself in both
 * themes. A chart colour is a measurement, so it must never read as "good" (green) or as
 * "bad" (the severity ramp), and it must be visible on the ground it is drawn on.
 */
const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

function token(scope: string, name: string): string {
  const m = scope.match(new RegExp(`^\\s*--${name}:\\s*(#[0-9A-Fa-f]{6})\\s*;`, 'm'));
  if (!m) throw new Error(`--${name} is not a hex colour in this block`);
  return m[1];
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function hue(hex: string): number {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const themes = [
  { name: 'light', scope: block(':root') },
  { name: 'dark', scope: block('.dark') },
];
const SERIES = [1, 2, 3, 4, 5].map(n => `chart-${n}`);

describe.each(themes)('chart tokens in the $name theme', ({ name: theme, scope }) => {
  it('paints the second chart colour plum', () => {
    expect(token(scope, 'chart-2').toUpperCase()).toBe(theme === 'light' ? '#A8649A' : '#A85C95');
  });

  it.each(SERIES)('%s is outside the green hues 90 to 170', (name) => {
    const h = hue(token(scope, name));
    expect(h < 90 || h > 170, `${name} sits at hue ${h.toFixed(0)}`).toBe(true);
  });

  it.each(SERIES)('%s meets 3:1 against the surface', (name) => {
    const ratio = contrast(token(scope, name), token(scope, 'surface'));
    expect(ratio, `${name} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  });

  it('keeps chart-1 and chart-2 at least 1.5:1 apart', () => {
    const ratio = contrast(token(scope, 'chart-1'), token(scope, 'chart-2'));
    expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(1.5);
  });
});
