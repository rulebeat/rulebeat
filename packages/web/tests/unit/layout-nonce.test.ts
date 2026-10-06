/**
 * The root layout owns the one inline script RuleBeat writes by hand (the theme initialiser that
 * stops a dark-mode flash). Under a nonce-based policy a script without the request's nonce is
 * blocked, which would put the flash back and, worse, fail silently. This calls the layout the way
 * React does (a server component is an async function returning an element tree) and looks at the
 * script element it produces. Only the framework boundary is faked: the request headers and
 * cookies, and next/font, which only resolves inside Next's own compiler.
 */
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

let requestHeaders: Record<string, string> = {};

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(requestHeaders),
}));
vi.mock('next/font/google', () => {
  const font = () => ({ variable: 'font-var' });
  return { Inter: font, Inter_Tight: font, IBM_Plex_Mono: font };
});

import RootLayout from '@/app/layout';

type Props = { children?: ReactNode; nonce?: string; dangerouslySetInnerHTML?: { __html: string } };

/** Depth-first search of an element tree for elements of one type. */
function findAll(node: ReactNode, type: string): ReactElement<Props>[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, type));
  const element = node as ReactElement<Props>;
  const own = element.type === type ? [element] : [];
  return [...own, ...findAll(element.props?.children, type)];
}

async function themeScript() {
  const tree = await RootLayout({ children: null });
  const scripts = findAll(tree, 'script');
  expect(scripts).toHaveLength(1);
  return scripts[0];
}

describe('root layout: theme init script', () => {
  beforeEach(() => {
    requestHeaders = {};
  });

  it('carries the request nonce the proxy forwarded', async () => {
    requestHeaders = { 'x-nonce': 'dGVzdC1ub25jZQ==' };
    const script = await themeScript();
    expect(script.props.nonce).toBe('dGVzdC1ub25jZQ==');
  });

  it('still inlines the theme script itself', async () => {
    requestHeaders = { 'x-nonce': 'dGVzdC1ub25jZQ==' };
    const script = await themeScript();
    expect(script.props.dangerouslySetInnerHTML?.__html).toBe(THEME_INIT_SCRIPT);
  });

  it('renders no nonce attribute when the proxy forwarded none', async () => {
    const script = await themeScript();
    expect(script.props.nonce).toBeUndefined();
  });
});
