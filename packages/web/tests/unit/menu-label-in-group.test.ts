/**
 * Architecture test: every `DropdownMenuLabel` sits inside a `DropdownMenuGroup` or
 * `DropdownMenuRadioGroup`.
 *
 * `DropdownMenuLabel` is Base UI's `Menu.GroupLabel`, which reads the group's context and throws
 * "MenuGroupContext is missing" when rendered straight inside the menu popup. The type system
 * cannot see that, and the menu only renders when it is opened, so a misplaced label crashes the
 * page on the first click rather than at build time. That is how the /scans Views menu shipped
 * broken. Vitest here has no React render layer, so this reads the JSX off disk instead.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNED_DIRS = ['app', 'components'];
const GROUPS = new Set(['DropdownMenuGroup', 'DropdownMenuRadioGroup']);

function findTsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...findTsxFiles(full));
    else if (entry.endsWith('.tsx')) found.push(full);
  }
  return found;
}

function tagName(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
}

/** Each label in the file, with whether a group element encloses it. */
function labelsIn(file: string): { line: number; inGroup: boolean }[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const labels: { line: number; inGroup: boolean }[] = [];
  function visit(node: ts.Node, inGroup: boolean) {
    const name = tagName(node);
    if (name === 'DropdownMenuLabel') {
      labels.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, inGroup });
    }
    const nextInGroup = inGroup || (name !== null && GROUPS.has(name));
    ts.forEachChild(node, child => visit(child, nextInGroup));
  }
  visit(source, false);
  return labels;
}

const files = SCANNED_DIRS.flatMap(d => findTsxFiles(join(WEB_ROOT, d)));
const labels = files.flatMap(file =>
  labelsIn(file).map(l => ({ ...l, at: `${relative(WEB_ROOT, file).split(sep).join('/')}:${l.line}` })),
);

describe('DropdownMenuLabel placement', () => {
  it('scans the real component tree', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(labels.length).toBeGreaterThan(0);
  });

  it('never renders a label outside a menu group', () => {
    expect(labels.filter(l => !l.inGroup).map(l => l.at)).toEqual([]);
  });
});
