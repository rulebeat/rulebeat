/**
 * Spec 022 — lib/db/audit.ts's non-persisting logging path, and writeAudit()'s own failure path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import {
  writeAudit, logAuthEvent, listAuditEntries, listAllAuditEntries, countAuditEntries,
} from '@/lib/db/audit';
import { createUser, type AppUser } from '@/lib/db/users';

beforeEach(() => {
  resetDb();
});

function makeUser(email: string): AppUser {
  const result = createUser({ email, role: 'admin' });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

describe('logAuthEvent', () => {
  it('writes a structured line to stdout and never touches the database', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logAuthEvent('something happened', { reason: 'test-reason' });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.message).toBe('something happened');
      expect(payload.reason).toBe('test-reason');
      expect(payload.level).toBe('warn');
      expect(typeof payload.ts).toBe('string');

      expect(countAuditEntries()).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('writeAudit failure logging', () => {
  it('logs to stderr and does not throw when the insert itself fails', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // actorId is NOT NULL — passing undefined bypasses TypeScript (via the cast) but still
      // fails at the real better-sqlite3 bind step, which is what this test needs to reach the
      // catch branch for real rather than simulating it.
      expect(() => writeAudit({
        actor: { id: undefined as unknown as string, email: 'broken@example.com' },
        action: 'rule.create',
        summary: 'this insert cannot succeed',
      })).not.toThrow();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(payload.level).toBe('error');
      expect(payload.message).toBe('audit write failed');
      expect(payload.action).toBe('rule.create');

      expect(countAuditEntries()).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('listAllAuditEntries vs the 200-row UI cap', () => {
  it('listAuditEntries caps at 200 while listAllAuditEntries returns everything', () => {
    const admin = makeUser('bulk@example.com');

    for (let i = 0; i < 205; i++) {
      writeAudit({ actor: admin, action: 'rule.create', summary: `entry ${i}` });
    }

    expect(listAuditEntries({ limit: 500 }).length).toBe(200);
    expect(listAllAuditEntries().length).toBe(205);
    expect(countAuditEntries()).toBe(205);
  });
});
