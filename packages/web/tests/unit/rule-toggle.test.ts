/**
 * The Rules tab's enable switch is `setPolicies(ps => applyRuleToggle(ps, await requestRuleToggle(policy)))`
 * in scans-client.tsx. This codebase has no React component-rendering test layer (Vitest runs
 * `environment: 'node'`, no @testing-library/react), so the switch's contract, that the row only
 * changes when the server accepted the change and a refusal comes back as a message, is verified
 * here with an injected fetch rather than by rendering the component.
 */
import { describe, expect, it } from 'vitest';
import { applyRuleToggle, requestRuleToggle } from '@/lib/rule-toggle';
import type { Rule } from '@/lib/types';

function rule(id: string, name: string, enabled: boolean): Rule {
  return {
    id, name, enabled,
    description: '',
    category: 'security',
    severity: 'medium',
    type: 'custom',
    scope: { level: 'resource' },
    resourceTypes: ['microsoft.storage/storageaccounts'],
    conditions: [],
  };
}

const rules = [rule('a', 'Storage without HTTPS', true), rule('b', 'Public IPs', false), rule('c', 'Old TLS', true)];

function respondWith(status: number, body?: unknown): typeof fetch {
  return async () => new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe('rule enable switch', () => {
  describe('the server did not accept the change', () => {
    it('shows the server\'s own message on a non-2xx and leaves the list unchanged', async () => {
      const outcome = await requestRuleToggle(rules[1], respondWith(400, { error: 'Applies to has been removed.' }));
      expect(outcome).toEqual({ ok: false, error: 'Applies to has been removed.' });
      expect(applyRuleToggle(rules, outcome)).toEqual(rules);
    });

    it('falls back to a message saying the change was not saved when the non-2xx has no error body', async () => {
      const outcome = await requestRuleToggle(rules[1], respondWith(500));
      expect(outcome).toEqual({ ok: false, error: 'Could not enable "Public IPs". The change was not saved.' });
      expect(applyRuleToggle(rules, outcome)).toEqual(rules);
    });

    it('falls back when the error body is JSON without an error string', async () => {
      const outcome = await requestRuleToggle(rules[0], respondWith(409, { message: 'conflict' }));
      expect(outcome).toEqual({ ok: false, error: 'Could not disable "Storage without HTTPS". The change was not saved.' });
      expect(applyRuleToggle(rules, outcome)).toEqual(rules);
    });

    it('treats a thrown fetch (network failure) as not saved', async () => {
      const failing: typeof fetch = async () => { throw new TypeError('Failed to fetch'); };
      const outcome = await requestRuleToggle(rules[0], failing);
      expect(outcome).toEqual({ ok: false, error: 'Could not disable "Storage without HTTPS". The change was not saved.' });
      expect(applyRuleToggle(rules, outcome)).toEqual(rules);
    });

    it('treats a followed redirect as not saved, even when it ends on a 2xx page', async () => {
      const redirected: typeof fetch = async () => {
        const res = new Response('<html>sign in</html>', { status: 200 });
        Object.defineProperty(res, 'redirected', { value: true });
        return res;
      };
      const outcome = await requestRuleToggle(rules[1], redirected);
      expect(outcome).toEqual({ ok: false, error: 'Could not enable "Public IPs". The change was not saved.' });
      expect(applyRuleToggle(rules, outcome)).toEqual(rules);
    });
  });

  describe('the server accepted the change', () => {
    it('flips only that rule\'s enabled flag', async () => {
      const outcome = await requestRuleToggle(rules[1], respondWith(200, { ...rules[1], enabled: true }));
      expect(outcome.ok).toBe(true);
      expect(applyRuleToggle(rules, outcome)).toEqual([rules[0], { ...rules[1], enabled: true }, rules[2]]);
    });

    it('sends the whole rule with enabled flipped as a PUT to that rule', async () => {
      let sent: { url: string; init?: RequestInit } | undefined;
      const capture: typeof fetch = async (url, init) => {
        sent = { url: String(url), init };
        return new Response(null, { status: 200 });
      };
      await requestRuleToggle(rules[0], capture);
      expect(sent?.url).toBe('/api/rules/a');
      expect(sent?.init?.method).toBe('PUT');
      expect(JSON.parse(String(sent?.init?.body))).toEqual({ ...rules[0], enabled: false });
    });
  });
});
