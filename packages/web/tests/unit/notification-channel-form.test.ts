/**
 * Issue #180: the Notifications settings form carries the "Include advisories" switch. This codebase
 * has no component-rendering test layer (see rule-form-payload.test.ts), so the form's model lives in
 * lib/notification-channel-form.ts and is tested directly: what a new channel starts with, what an
 * edit starts with, and what the create and update requests send.
 */
import { describe, expect, it } from 'vitest';
import type { NotificationChannelSummary } from '@/lib/db/notification-channels';
import { DEFAULT_FORM, buildSaveBody, formFromSummary } from '@/lib/notification-channel-form';

function summary(over: Partial<NotificationChannelSummary> = {}): NotificationChannelSummary {
  return {
    id: 'ch-1', name: 'Security hook', type: 'teams', urlHost: 'example.test', emailConfig: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    lastNotifiedAt: null, lastError: null, includeAdvisories: false,
    ...over,
  } as NotificationChannelSummary;
}

describe('a new channel', () => {
  it('starts with Include advisories off', () => {
    expect(DEFAULT_FORM.includeAdvisories).toBe(false);
  });

  it('sends the setting it was given on create', () => {
    expect(buildSaveBody({ ...DEFAULT_FORM, name: 'A', url: 'https://example.test/h', includeAdvisories: true }))
      .toMatchObject({ name: 'A', includeAdvisories: true });
    expect(buildSaveBody({ ...DEFAULT_FORM, name: 'A', url: 'https://example.test/h' }))
      .toMatchObject({ includeAdvisories: false });
  });
});

describe('editing a saved channel', () => {
  it('starts from the saved setting, on or off', () => {
    expect(formFromSummary(summary({ includeAdvisories: true })).includeAdvisories).toBe(true);
    expect(formFromSummary(summary({ includeAdvisories: false })).includeAdvisories).toBe(false);
  });

  it('sends the setting with the update, for a webhook and for an email channel', () => {
    const hook = formFromSummary(summary({ includeAdvisories: true }));
    expect(buildSaveBody(hook, 'ch-1')).toMatchObject({ id: 'ch-1', includeAdvisories: true });

    const mail = formFromSummary(summary({
      type: 'email',
      emailConfig: { host: 'smtp.example.com', port: 587, tls: 'starttls', username: '', fromAddress: 'a@example.com', toAddresses: 'b@example.com' },
      includeAdvisories: true,
    }));
    expect(buildSaveBody({ ...mail, includeAdvisories: false }, 'ch-2'))
      .toMatchObject({ id: 'ch-2', type: 'email', includeAdvisories: false, config: { host: 'smtp.example.com' } });
  });
});
