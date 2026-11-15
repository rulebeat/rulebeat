/** The full-page no-access state takes its heading from the limits module, so the widgets' first empty
 *  reason and the page can never say two different things. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('@/lib/widget-limits', () => ({ NO_ACCESS_HEADING: 'Heading from the module' }));

it('renders the heading the limits module holds', async () => {
  const { NoAccessState } = await import('@/components/findings/no-access-state');
  const html = renderToStaticMarkup(createElement(NoAccessState));
  expect(html).toContain('Heading from the module');
  expect(html).not.toContain('You have been given no access');
});
