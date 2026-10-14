/**
 * #267, story 75: an Editor without the Directory Scope finds Microsoft Graph unavailable where they write a
 * query or a Personal rule, with the reason, rather than an option that only fails once they run it. The
 * routes already refuse (`mayQueryDirectory`); this is what the Query page and the New personal rule page
 * show, driven from the pages themselves with only the session mocked.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser, type AppUser } from '@/lib/db/users';
import { replaceAssignmentsOn } from '@/lib/db/role-assignments';
import { inTransaction } from '@/lib/db/exec';
import { NEEDS_DIRECTORY_MESSAGE } from '@/lib/written-query';
import { DIRECTORY_SCOPE_PATH } from '@/lib/access-model';
import { QueryPageClient } from '@/components/query/query-client';
import { ChecksPickerDialog } from '@/components/rules/checks-picker-dialog';
import { resetDb } from '../helpers/db';

const TENANT = '00000000-0000-0000-0000-0000000000f0';
const SUB = '/subscriptions/00000000-0000-0000-0000-00000000000a';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('not found'); },
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => '/query',
  useSearchParams: () => new URLSearchParams(),
}));
// The dialog renders into a portal, which server rendering leaves empty: drawn inline so its options can be read.
vi.mock('@/components/ui/dialog', () => {
  const inline = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: inline, DialogTrigger: inline, DialogPortal: inline, DialogBackdrop: () => null, DialogViewport: inline,
    DialogPopup: inline, DialogTitle: inline, DialogClose: inline,
  };
});

const { default: QueryPage } = await import('@/app/(app)/query/page');
const { default: NewPersonalRulePage } = await import('@/app/(app)/library/personal/new/page');

function propsWith(node: ReactNode, marker: string): Record<string, unknown> {
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) { queue.push(...next); continue; }
    if (!isValidElement(next)) continue;
    const props = (next as ReactElement<Record<string, unknown>>).props;
    if (marker in props) return props;
    queue.push(props.children as ReactNode);
  }
  throw new Error(`${marker} not rendered`);
}

async function editorHolding(email: string, scopes: string[]): Promise<AppUser> {
  const result = await createUser({ email, role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await inTransaction(tx => replaceAssignmentsOn(tx, result.user.id, scopes.map(scope => ({ tenantId: TENANT, scope, role: 'editor' as const }))));
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
  return result.user;
}

const GRAPH_BUTTON_DISABLED = /<button[^>]*disabled=""[^>]*>Microsoft Graph<\/button>/;

beforeEach(async () => {
  await resetDb();
});

describe('Microsoft Graph for an Editor without the Directory Scope', () => {
  it('is offered on neither page, with the reason', async () => {
    await editorHolding('editor@example.com', [SUB]);
    expect(propsWith(await QueryPage(), 'limitTo').directoryUnavailable).toBe(NEEDS_DIRECTORY_MESSAGE);
    expect(propsWith(await NewPersonalRulePage(), 'scopeLimit').directoryUnavailable).toBe(NEEDS_DIRECTORY_MESSAGE);
  });

  it('is offered on both pages to an Editor who holds the Directory', async () => {
    await editorHolding('editor@example.com', [SUB, DIRECTORY_SCOPE_PATH]);
    expect(propsWith(await QueryPage(), 'limitTo').directoryUnavailable).toBeUndefined();
    expect(propsWith(await NewPersonalRulePage(), 'scopeLimit').directoryUnavailable).toBeUndefined();
  });
});

describe('the Query page with Microsoft Graph unavailable', () => {
  it('disables the Microsoft Graph option and says why', () => {
    const html = renderToStaticMarkup(createElement(QueryPageClient, { defaultCategoryId: 'security', directoryUnavailable: NEEDS_DIRECTORY_MESSAGE }));
    expect(html).toMatch(GRAPH_BUTTON_DISABLED);
    expect(html).toContain('Querying Microsoft Graph needs access to the Directory');
  });

  it('leaves it enabled, with no reason, when it is available', () => {
    const html = renderToStaticMarkup(createElement(QueryPageClient, { defaultCategoryId: 'security' }));
    expect(html).toContain('>Microsoft Graph</button>');
    expect(html).not.toMatch(GRAPH_BUTTON_DISABLED);
    expect(html).not.toContain('Querying Microsoft Graph needs access to the Directory');
  });
});

describe('what a new Personal rule checks, with Microsoft Graph unavailable', () => {
  const noop = () => undefined;
  const directoryButton = (html: string) => /<button[^>]*>(?:(?!<\/button>)[\s\S])*Directory objects(?:(?!<\/button>)[\s\S])*<\/button>/.exec(html)?.[0] ?? '';

  it('disables Directory objects and says why', () => {
    const html = renderToStaticMarkup(createElement(ChecksPickerDialog, { onSelect: noop, onClose: noop, directoryUnavailable: NEEDS_DIRECTORY_MESSAGE }));
    const button = directoryButton(html);
    expect(button).toContain('disabled=""');
    expect(button).toContain('Querying Microsoft Graph needs access to the Directory');
  });

  it('leaves Directory objects enabled when it is available', () => {
    const button = directoryButton(renderToStaticMarkup(createElement(ChecksPickerDialog, { onSelect: noop, onClose: noop })));
    expect(button).toContain('Directory objects');
    expect(button).not.toContain('disabled=""');
  });
});
