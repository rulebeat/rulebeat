import { describe, expect, it } from 'vitest';
import { extractAzureErrorMessage } from '../src/errors.js';

describe('extractAzureErrorMessage()', () => {
  it('unwraps err.details[0].message when present', () => {
    const err = Object.assign(new Error('generic wrapper message'), {
      details: [{ message: 'Insufficient privileges to complete the operation.' }],
    });

    expect(extractAzureErrorMessage(err)).toBe('Insufficient privileges to complete the operation.');
  });

  it('unwraps err.response.parsedBody.error.message when present', () => {
    const err = Object.assign(new Error('generic wrapper message'), {
      response: { parsedBody: { error: { message: 'The subscription is not registered.' } } },
    });

    expect(extractAzureErrorMessage(err)).toBe('The subscription is not registered.');
  });

  it('falls back to err.message for a plain Error with no Azure shape', () => {
    const err = new Error('plain failure');

    expect(extractAzureErrorMessage(err)).toBe('plain failure');
  });

  it('has no status-code gate — unwraps regardless of statusCode, since this is server-log-only', () => {
    const err = Object.assign(new Error('generic wrapper message'), {
      statusCode: 500,
      details: [{ message: 'internal detail' }],
    });

    expect(extractAzureErrorMessage(err)).toBe('internal detail');
  });

  it('falls back to err.message when details is an empty array', () => {
    const err = Object.assign(new Error('generic wrapper message'), { details: [] });

    expect(extractAzureErrorMessage(err)).toBe('generic wrapper message');
  });

  it('returns String(err) for a non-Error thrown value', () => {
    expect(extractAzureErrorMessage('a string throw')).toBe('a string throw');
  });
});
