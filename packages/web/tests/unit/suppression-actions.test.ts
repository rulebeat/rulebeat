/**
 * The findings explorer's suppress/unsuppress controls (findings-explorer-client.tsx) used to
 * update the screen on the strength of the request alone: `handleUnsuppress` removed the
 * suppression without checking the DELETE's response, and the widget-mode suppressions load
 * collapsed a failed GET into the same `[]` as a genuinely empty one. This codebase has no React
 * component-rendering test layer (Vitest runs `environment: 'node'`, no @testing-library/react —
 * see rule-toggle.test.ts), so the contract, that the screen only changes when the server accepted
 * the change and a failed load never looks like empty data, is verified here against the
 * extracted request/apply functions with an injected fetch, the same approach rule-toggle.test.ts
 * uses for the Rules tab's enable switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestSuppress, requestUnsuppress, applySuppress, applyUnsuppress, applySuppressionsLoad,
} from '@/lib/suppression-actions';
import type { Suppression } from '@/lib/types';

function respondWith(status: number, body?: unknown): typeof fetch {
  return async () => new Response(body === undefined ? null : JSON.stringify(body), { status });
}

const finding = { fingerprint: 'fp-1', resourceId: '/subscriptions/x/resourceGroups/y/providers/z' };

const existing: Suppression[] = [
  { id: 's1', fingerprint: 'fp-1', resourceId: finding.resourceId, reason: 'accepted risk', suppressedAt: '2024-01-01T00:00:00.000Z' },
  { id: 's2', fingerprint: 'fp-2', reason: 'false positive', suppressedAt: '2024-01-02T00:00:00.000Z' },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('suppress request', () => {
  describe('the server did not accept the change', () => {
    it('shows the server\'s own message on a non-2xx and leaves the list unchanged', async () => {
      const outcome = await requestSuppress(finding, 'accepted risk', undefined, respondWith(403, { error: 'Forbidden' }));
      expect(outcome).toEqual({ ok: false, error: 'Forbidden' });
      expect(applySuppress(existing, outcome)).toBe(existing);
    });

    it('falls back to a stable message when the non-2xx has no error body', async () => {
      const outcome = await requestSuppress(finding, 'accepted risk', undefined, respondWith(500));
      expect(outcome).toEqual({ ok: false, error: 'Could not suppress this finding. The change was not saved.' });
      expect(applySuppress(existing, outcome)).toBe(existing);
    });

    it('treats a thrown fetch (network failure) as not saved', async () => {
      const failing: typeof fetch = async () => { throw new TypeError('Failed to fetch'); };
      const outcome = await requestSuppress(finding, 'accepted risk', undefined, failing);
      expect(outcome).toEqual({ ok: false, error: 'Could not suppress this finding. The change was not saved.' });
      expect(applySuppress(existing, outcome)).toBe(existing);
    });

    it('treats a followed redirect as not saved, even when it ends on a 2xx page', async () => {
      const redirected: typeof fetch = async () => {
        const res = new Response('<html>sign in</html>', { status: 200 });
        Object.defineProperty(res, 'redirected', { value: true });
        return res;
      };
      const outcome = await requestSuppress(finding, 'accepted risk', undefined, redirected);
      expect(outcome).toEqual({ ok: false, error: 'Could not suppress this finding. The change was not saved.' });
      expect(applySuppress(existing, outcome)).toBe(existing);
    });
  });

  describe('the server accepted the change', () => {
    it('appends the created suppression', async () => {
      const created: Suppression = { id: 's3', fingerprint: 'fp-1', resourceId: finding.resourceId, reason: 'accepted risk', suppressedAt: '2024-01-03T00:00:00.000Z' };
      const outcome = await requestSuppress(finding, 'accepted risk', undefined, respondWith(201, created));
      expect(outcome).toEqual({ ok: true, suppression: created });
      expect(applySuppress(existing, outcome)).toEqual([...existing, created]);
    });

    it('sends the fingerprint, resourceId, reason and expiresAt as a POST', async () => {
      let sent: { url: string; init?: RequestInit } | undefined;
      const capture: typeof fetch = async (url, init) => {
        sent = { url: String(url), init };
        return new Response(JSON.stringify({ id: 's3', ...finding, reason: 'accepted risk', suppressedAt: '2024-01-03T00:00:00.000Z' }), { status: 201 });
      };
      await requestSuppress(finding, 'accepted risk', '2024-06-01', capture);
      expect(sent?.url).toBe('/api/suppressions');
      expect(sent?.init?.method).toBe('POST');
      expect(JSON.parse(String(sent?.init?.body))).toEqual({
        fingerprint: 'fp-1', resourceId: finding.resourceId, reason: 'accepted risk', expiresAt: '2024-06-01',
      });
    });
  });
});

describe('unsuppress request', () => {
  describe('the server did not accept the change', () => {
    it('shows the server\'s own message on a non-2xx and leaves the suppression on screen', async () => {
      const outcome = await requestUnsuppress('s1', respondWith(403, { error: 'Forbidden' }));
      expect(outcome).toEqual({ ok: false, error: 'Forbidden' });
      expect(applyUnsuppress(existing, outcome)).toBe(existing);
    });

    it('falls back to a stable message on a 404 with no usable error body', async () => {
      const outcome = await requestUnsuppress('s1', respondWith(404));
      expect(outcome).toEqual({ ok: false, error: 'Could not remove the suppression. The change was not saved.' });
      expect(applyUnsuppress(existing, outcome)).toBe(existing);
    });

    it('treats a thrown fetch (network failure) as not saved', async () => {
      const failing: typeof fetch = async () => { throw new TypeError('Failed to fetch'); };
      const outcome = await requestUnsuppress('s1', failing);
      expect(outcome).toEqual({ ok: false, error: 'Could not remove the suppression. The change was not saved.' });
      expect(applyUnsuppress(existing, outcome)).toBe(existing);
    });
  });

  describe('the server accepted the change', () => {
    it('removes only that suppression', async () => {
      const outcome = await requestUnsuppress('s1', respondWith(204));
      expect(outcome).toEqual({ ok: true, id: 's1' });
      expect(applyUnsuppress(existing, outcome)).toEqual([existing[1]]);
    });

    it('sends a DELETE to that suppression\'s own route', async () => {
      let sent: { url: string; init?: RequestInit } | undefined;
      const capture: typeof fetch = async (url, init) => {
        sent = { url: String(url), init };
        return new Response(null, { status: 204 });
      };
      await requestUnsuppress('s1', capture);
      expect(sent?.url).toBe('/api/suppressions/s1');
      expect(sent?.init?.method).toBe('DELETE');
    });
  });
});

describe('suppressions load (widget mode, no suppressions prop)', () => {
  it('reports failed on a non-2xx, distinct from a genuinely empty list', () => {
    const state = applySuppressionsLoad({ ok: false });
    expect(state).toEqual({ suppressions: [], failed: true });
  });

  it('reports a genuinely empty list as not failed', () => {
    const state = applySuppressionsLoad({ ok: true, data: [] });
    expect(state).toEqual({ suppressions: [], failed: false });
  });

  it('carries through a successful non-empty load as not failed', () => {
    const state = applySuppressionsLoad({ ok: true, data: existing });
    expect(state).toEqual({ suppressions: existing, failed: false });
  });
});
