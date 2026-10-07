import { isCommitDateVersion, versionLabel as markerVersionLabel } from './rule-version-markers';

export interface QueryDiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** A longest-common-subsequence diff. Ties remove before adding, so a replacement reads in order. */
export function diffQueryLines(before: string, after: string): QueryDiffLine[] {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n');
  if (before === after) return a.map(text => ({ kind: 'same', text }));
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const diff: QueryDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      diff.push({ kind: 'same', text: a[i++] });
      j++;
    } else if (i < a.length && (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
      diff.push({ kind: 'removed', text: a[i++] });
    } else {
      diff.push({ kind: 'added', text: b[j++] });
    }
  }
  return diff;
}

/** The shared version label, plus wording for a missing version and the time for two versions synced on one day. */
export function versionLabel(version: string | null | undefined, showTime = false): string {
  if (!version) return 'version not recorded';
  if (showTime && isCommitDateVersion(version)) {
    return `${new Date(version).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  }
  return markerVersionLabel(version);
}
