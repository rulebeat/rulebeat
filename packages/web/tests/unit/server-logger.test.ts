import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScanLogger } from '@/lib/server-logger';

describe('createScanLogger()', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
  });

  it('writes one JSON.parse-able console.log line carrying the message, context, and fields', async () => {
    const log = createScanLogger({ runId: 'r1' });

    log('msg', { ruleId: 'x' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);

    expect(parsed).toMatchObject({
      message: 'msg',
      runId: 'r1',
      ruleId: 'x',
      level: 'info',
    });
    expect(typeof parsed.ts).toBe('string');
  });

  it('carries an explicit level through unchanged instead of defaulting to info', async () => {
    const log = createScanLogger({ runId: 'r1' });

    log('boom', { level: 'error' });

    const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(parsed.level).toBe('error');
  });

  it('writes a valid line even with no fields and no context at all', async () => {
    const log = createScanLogger();

    log('bare message');

    const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(parsed.message).toBe('bare message');
    expect(parsed.level).toBe('info');
    expect(parsed.runId).toBeUndefined();
  });
});
