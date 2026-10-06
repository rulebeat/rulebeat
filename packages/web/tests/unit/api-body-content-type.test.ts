/**
 * A cross-site "simple request" (no CORS preflight) can only ever carry a Content-Type of
 * text/plain, application/x-www-form-urlencoded or multipart/form-data — a browser always sets one
 * of those three automatically whenever a body is present, and never omits it. So a route that
 * parses whatever body it is handed as JSON regardless of Content-Type will also happily parse one
 * of those three, defeating the point of requiring an explicit JSON body for a state-changing
 * request. parseJsonBody() and parseOptionalJsonBody() (lib/api-body.ts) both require the request
 * to actually say it is sending JSON before trying to parse it as JSON.
 */
import { describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { isJsonContentType, parseJsonBody, parseOptionalJsonBody } from '@/lib/api-body';

function request(body: string | null, contentType?: string | null): Request {
  const headers = new Headers();
  if (contentType !== undefined && contentType !== null) headers.set('content-type', contentType);
  return new Request('https://rulebeat.example.com/api/example', {
    method: 'POST',
    headers,
    body,
  });
}

describe('isJsonContentType', () => {
  it('accepts application/json', () => {
    expect(isJsonContentType('application/json')).toBe(true);
  });

  it('accepts application/json with a charset parameter', () => {
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
  });

  it('accepts a structured +json suffix', () => {
    expect(isJsonContentType('application/merge-patch+json')).toBe(true);
  });

  it('rejects a missing Content-Type', () => {
    expect(isJsonContentType(null)).toBe(false);
  });

  it('rejects text/plain', () => {
    expect(isJsonContentType('text/plain')).toBe(false);
  });

  it('rejects application/x-www-form-urlencoded', () => {
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
  });
});

describe('parseJsonBody', () => {
  it('returns 415 when the Content-Type is text/plain', async () => {
    const result = await parseJsonBody(request('{"a":1}', 'text/plain'));
    expect(result).toBeInstanceOf(NextResponse);
    const res = result as NextResponse;
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'Content-Type must be application/json.' });
  });

  it('returns 415 when the Content-Type is missing entirely', async () => {
    const result = await parseJsonBody(request('{"a":1}', null));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(415);
  });

  it('parses the body when the Content-Type is application/json', async () => {
    const result = await parseJsonBody<{ a: number }>(request('{"a":1}', 'application/json'));
    expect(result).toEqual({ a: 1 });
  });

  it('still returns 400 on malformed JSON when the Content-Type is correct', async () => {
    const result = await parseJsonBody(request('{not json', 'application/json'));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });
});

describe('parseOptionalJsonBody', () => {
  it('returns the fallback for an empty body with no Content-Type (the "test what is saved" case)', async () => {
    const result = await parseOptionalJsonBody(request(null, null), { ok: true as const });
    expect(result).toEqual({ ok: true });
  });

  it('parses the body when the Content-Type is application/json', async () => {
    const result = await parseOptionalJsonBody<{ a: number }>(
      request('{"a":1}', 'application/json'),
      { a: 0 },
    );
    expect(result).toEqual({ a: 1 });
  });

  it('returns 415 for a non-empty body with a non-JSON Content-Type', async () => {
    const result = await parseOptionalJsonBody(request('a=1', 'application/x-www-form-urlencoded'), {});
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(415);
  });

  it('returns 415 for an empty body whose Content-Type is set but not JSON', async () => {
    const result = await parseOptionalJsonBody(request('', 'application/x-www-form-urlencoded'), {});
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(415);
  });

  it('still returns 400 on malformed JSON when the Content-Type is correct', async () => {
    const result = await parseOptionalJsonBody(request('{not json', 'application/json'), {});
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });
});
