/**
 * The Rules tab's bulk action bar is
 * `setPolicies(ps => applyBulkToggle(ps, await requestBulkToggle(action, ids)))` in
 * scans-client.tsx, clearing the selection only on success. This codebase has no React
 * component-rendering test layer (Vitest runs `environment: 'node'`, no @testing-library/react),
 * so the contract, that rows only change when the server accepted the change and a refusal comes
 * back as a message, is verified here with an injected fetch, the same way as the single switch.
 */
import { describe, expect, it } from 'vitest';
import { applyBulkToggle, bulkToggleMessage, requestBulkToggle } from '@/lib/rule-bulk-toggle';
import type { Rule } from '@/lib/types';

function rule(id: string, enabled: boolean): Rule {
  return {
    id, name: `Rule ${id}`, enabled,
    description: '',
    category: 'security',
    severity: 'medium',
    type: 'custom',
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.storage/storageaccounts'],
    conditions: [],
  };
}

const rules = [rule('a', true), rule('b', false), rule('c', true), rule('d', false)];

function respondWith(status: number, body?: unknown): typeof fetch {
  return async () => new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe('rule bulk action', () => {
  describe('the server did not accept the change', () => {
    it('shows the server\'s own message on a non-2xx and leaves the list unchanged', async () => {
      const outcome = await requestBulkToggle('disable', ['a', 'c'], respondWith(403, { error: 'Forbidden' }));
      expect(outcome).toEqual({ ok: false, error: 'Forbidden' });
      expect(applyBulkToggle(rules, outcome)).toEqual(rules);
    });

    it('falls back to a message saying the change was not saved when the non-2xx has no error body', async () => {
      const outcome = await requestBulkToggle('disable', ['a', 'c'], respondWith(500));
      expect(outcome).toEqual({ ok: false, error: 'Could not disable 2 rules. The change was not saved.' });
      expect(applyBulkToggle(rules, outcome)).toEqual(rules);
    });

    it('falls back when the error string is blank', async () => {
      const outcome = await requestBulkToggle('enable', ['b'], respondWith(400, { error: '  ' }));
      expect(outcome).toEqual({ ok: false, error: 'Could not enable 1 rule. The change was not saved.' });
      expect(applyBulkToggle(rules, outcome)).toEqual(rules);
    });

    it('treats a thrown fetch (network failure) as not saved', async () => {
      const failing: typeof fetch = async () => { throw new TypeError('Failed to fetch'); };
      const outcome = await requestBulkToggle('enable', ['b', 'd'], failing);
      expect(outcome).toEqual({ ok: false, error: 'Could not enable 2 rules. The change was not saved.' });
      expect(applyBulkToggle(rules, outcome)).toEqual(rules);
    });

    it('treats a followed redirect as not saved, even when it ends on a 2xx page', async () => {
      const redirected: typeof fetch = async () => {
        const res = new Response('<html>sign in</html>', { status: 200 });
        Object.defineProperty(res, 'redirected', { value: true });
        return res;
      };
      const outcome = await requestBulkToggle('disable', ['a'], redirected);
      expect(outcome).toEqual({ ok: false, error: 'Could not disable 1 rule. The change was not saved.' });
      expect(applyBulkToggle(rules, outcome)).toEqual(rules);
    });
  });

  describe('the server accepted the change', () => {
    it('changes exactly the sent rules and reports the count', async () => {
      const outcome = await requestBulkToggle('disable', ['a', 'c'], respondWith(200, { updated: 2, notFound: [] }));
      expect(outcome).toEqual({ ok: true, action: 'disable', updatedIds: ['a', 'c'], notFound: [] });
      expect(applyBulkToggle(rules, outcome)).toEqual([
        { ...rules[0], enabled: false }, rules[1], { ...rules[2], enabled: false }, rules[3],
      ]);
      if (outcome.ok) expect(bulkToggleMessage(outcome)).toBe('Disabled 2 rules.');
    });

    it('leaves ids the server no longer has untouched and names them as skipped', async () => {
      const outcome = await requestBulkToggle('enable', ['b', 'd'], respondWith(200, { updated: 1, notFound: ['d'] }));
      expect(outcome).toEqual({ ok: true, action: 'enable', updatedIds: ['b'], notFound: ['d'] });
      expect(applyBulkToggle(rules, outcome)).toEqual([rules[0], { ...rules[1], enabled: true }, rules[2], rules[3]]);
      if (outcome.ok) expect(bulkToggleMessage(outcome)).toBe('Enabled 1 rule. 1 no longer exists and was skipped.');
    });

    it('sends only the given ids as a PATCH to the bulk route', async () => {
      let sent: { url: string; init?: RequestInit } | undefined;
      const capture: typeof fetch = async (url, init) => {
        sent = { url: String(url), init };
        return new Response(JSON.stringify({ updated: 2, notFound: [] }), { status: 200 });
      };
      await requestBulkToggle('enable', ['b', 'd'], capture);
      expect(sent?.url).toBe('/api/rules/bulk');
      expect(sent?.init?.method).toBe('PATCH');
      expect(JSON.parse(String(sent?.init?.body))).toEqual({ enable: ['b', 'd'] });
    });
  });

  describe('message', () => {
    it('uses the plural and the singular for skipped ids', () => {
      const ids = Array.from({ length: 18 }, (_, i) => `r${i}`);
      expect(bulkToggleMessage({ ok: true, action: 'disable', updatedIds: ids, notFound: [] }))
        .toBe('Disabled 18 rules.');
      expect(bulkToggleMessage({ ok: true, action: 'disable', updatedIds: ids.slice(2), notFound: ids.slice(0, 2) }))
        .toBe('Disabled 16 rules. 2 no longer exist and were skipped.');
    });
  });
});
