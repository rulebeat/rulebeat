/**
 * Spec 008 — pure classification of a schema-route HTTP outcome into 'ok' | 'not-found' |
 * 'unavailable', so the taxonomy the client relies on to tell "Azure is down" apart from "this type
 * genuinely has no schema" lives in one tested function rather than inline in a Promise.all.
 */
import { describe, expect, it } from 'vitest';
import { classifySchemaStatus } from '@/lib/schema-fetch-status';

describe('classifySchemaStatus', () => {
  it('classifies a successful response as ok regardless of status code', () => {
    expect(classifySchemaStatus(true, 200)).toBe('ok');
  });

  it('classifies a 404 as not-found', () => {
    expect(classifySchemaStatus(false, 404)).toBe('not-found');
  });

  it('classifies a 503 as unavailable', () => {
    expect(classifySchemaStatus(false, 503)).toBe('unavailable');
  });

  it('classifies a 500 as unavailable', () => {
    expect(classifySchemaStatus(false, 500)).toBe('unavailable');
  });
});
