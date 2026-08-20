/**
 * Codex review Phase 5, item 3 (RB-QA-018): a route that calls `req.json()` directly, with no
 * try/catch, throws an uncaught `SyntaxError` on a malformed body — every one of these routes
 * documents a 400 for a bad request, but malformed JSON specifically fell through to Next's
 * generic 500 instead.
 *
 * The fix is `parseJsonBody()` (lib/api-body.ts), which returns the documented 400 for bad JSON
 * and otherwise behaves like `req.json()`. A handful of routes handle it with their own inline
 * try/catch instead (an empty body means "test what's currently saved" for a couple of them), which
 * is equally safe — so this test doesn't force every call site onto the shared helper, it only
 * bans the unsafe third option: a raw, unguarded `req.json()` call.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_DIR = join(WEB_ROOT, 'app', 'api');

function findRouteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...findRouteFiles(full));
    else if (entry === 'route.ts' || entry === 'route.tsx') found.push(full);
  }
  return found;
}

const routeFiles = findRouteFiles(API_DIR).map(full => ({
  rel: relative(API_DIR, full).split(sep).join('/'),
  source: readFileSync(full, 'utf8'),
  lines: readFileSync(full, 'utf8').split('\n'),
}));

/**
 * A raw `req.json()` call is safe only if it's reached through `parseJsonBody(...)`, or if it sits
 * inside a `try { ... } catch { ... }` of its own — checked with a small window rather than a real
 * parser, since every call site in this codebase is a one-line `body = await req.json()` a couple
 * of lines below its own `try {`.
 */
function unsafeJsonCalls(lines: string[]): number[] {
  const unsafe: number[] = [];
  lines.forEach((line, i) => {
    if (!/req\.json\(/.test(line)) return;
    if (/parseJsonBody/.test(line)) return;

    const before = lines.slice(Math.max(0, i - 5), i).join('\n');
    const after = lines.slice(i, Math.min(lines.length, i + 5)).join('\n');
    const hasTryBefore = /try\s*\{/.test(before);
    const hasCatchAfter = /\}\s*catch/.test(after);
    if (!hasTryBefore || !hasCatchAfter) unsafe.push(i + 1);
  });
  return unsafe;
}

describe("RB-QA-018 · no route parses req.json() without a guard against malformed JSON", () => {
  it('found the API routes at all (guards against this suite silently testing nothing)', () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it('every raw req.json() call is either parseJsonBody() or wrapped in its own try/catch', () => {
    const offenders: string[] = [];
    for (const r of routeFiles) {
      for (const lineNo of unsafeJsonCalls(r.lines)) {
        offenders.push(`${r.rel}:${lineNo}`);
      }
    }
    expect(offenders, [
      'These call sites parse the request body with a raw req.json() and no try/catch, so a',
      'malformed JSON body throws an uncaught SyntaxError instead of the route\'s documented 400.',
      'Use parseJsonBody() from lib/api-body.ts, or wrap the call in its own try/catch.',
    ].join(' ')).toEqual([]);
  });
});
