import { describe, expect, it } from 'vitest';
import { OwnUrlWrites } from '@/lib/own-url-writes';

describe('OwnUrlWrites', () => {
  it('reads the URL the page started on as its own', () => {
    expect(new OwnUrlWrites('tab=results').isOutside('tab=results')).toBe(false);
  });

  it('reads what the explorer wrote as its own, even when an earlier write lands after a later one', () => {
    const writes = new OwnUrlWrites('tab=results');
    writes.record('tab=results&q=a');
    writes.record('tab=results&q=ab');
    expect(writes.isOutside('tab=results&q=ab')).toBe(false);
    expect(writes.isOutside('tab=results&q=a')).toBe(false);
  });

  it('reads any other URL as an outside navigation, once, then counts the writes after it as its own', () => {
    const writes = new OwnUrlWrites('tab=results');
    expect(writes.isOutside('tab=results&view=v1&severity=high')).toBe(true);
    expect(writes.isOutside('tab=results&view=v1&severity=high')).toBe(false);
    writes.record('tab=results&view=v1&severity=high&q=x');
    expect(writes.isOutside('tab=results&view=v1&severity=high&q=x')).toBe(false);
  });

  it('does not take a URL it wrote long ago as its own after an outside navigation', () => {
    const writes = new OwnUrlWrites('tab=results');
    writes.record('tab=results&q=old');
    expect(writes.isOutside('tab=results&view=v1')).toBe(true);
    // Back to where the explorer once was: the explorer is now on the saved view, so start again.
    expect(writes.isOutside('tab=results&q=old')).toBe(true);
  });

  it('reads a navigation made on purpose as outside even to a URL the explorer wrote before', () => {
    const writes = new OwnUrlWrites('tab=results');
    writes.record('tab=results&view=v1&severity=high');
    writes.forget();
    expect(writes.isOutside('tab=results&view=v1&severity=high')).toBe(true);
  });
});
