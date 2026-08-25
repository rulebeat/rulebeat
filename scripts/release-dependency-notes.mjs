#!/usr/bin/env node
// Derives the "### Dependencies" block of a release from what the manifests actually say, by
// diffing them between the last release tag and the commit being released.
//
// Deliberately NOT from commit subjects. Those are not a source of truth: anyone can write
// "build(deps): bump ...", a bump can be reverted later in the same window and the subject still
// claims it happened, Dependabot truncates its own titles once they get long (commit 487d1fb has
// no versions in it at all), and a grouped PR collapses twenty packages into one unparseable
// sentence. Manifests cannot lie about their own contents.
//
// Scope is direct RUNTIME dependencies of the two published packages. devDependencies, the root
// manifest's tooling, and GitHub Actions bumps are all excluded: none of them is in the image, so
// none belongs in release notes for people running RuleBeat.
//
// A derived bullet also cannot explain impact -- 0.2.1's hand-written nodemailer entry ("upstream
// fixes for header and CRLF injection ... hardened STARTTLS") is far better than any "from 7.0.13
// to 9.0.5" this could produce. So anything a human already named in [Unreleased] is skipped
// rather than duplicated or overwritten.

/** The manifests whose `dependencies` actually reach the image. */
export const RUNTIME_MANIFESTS = Object.freeze([
  'packages/core/package.json',
  'packages/web/package.json',
]);

/**
 * @param {Record<string,string>} baseTexts path -> file contents at the previous release
 * @param {Record<string,string>} headTexts path -> file contents at the commit being released
 * @returns {{ name: string, from: string|null, to: string|null }[]} sorted by package name
 */
export function diffRuntimeDependencies(baseTexts, headTexts) {
  /** @type {Map<string, { from: string|null, to: string|null }>} */
  const changes = new Map();

  for (const path of RUNTIME_MANIFESTS) {
    const before = parseDeps(baseTexts[path]);
    const after = parseDeps(headTexts[path]);
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const from = before[name] ?? null;
      const to = after[name] ?? null;
      if (from === to) continue;
      // A package present in both workspaces collapses to one bullet; the widest span wins, which
      // is what a reader cares about.
      const existing = changes.get(name);
      changes.set(name, {
        from: existing?.from ?? from,
        to: to ?? existing?.to ?? null,
      });
    }
  }

  return [...changes.entries()]
    .map(([name, span]) => ({ name, ...span }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseDeps(text) {
  if (!text) return {};
  try {
    return JSON.parse(text).dependencies ?? {};
  } catch {
    return {};
  }
}

/**
 * @param {{ name: string, from: string|null, to: string|null }[]} changes
 * @returns {string[]} markdown bullets, without the leading "- "
 */
export function formatDependencyBullets(changes) {
  return changes.map(({ name, from, to }) => {
    if (from === null) return `Added \`${name}\` ${clean(to)}.`;
    if (to === null) return `Removed \`${name}\`.`;
    return `Updated \`${name}\` from ${clean(from)} to ${clean(to)}.`;
  });
}

/** Range prefixes are noise in prose; "^9.0.5" reads as "9.0.5" to a human. */
function clean(range) {
  return String(range).replace(/^[\^~>=<\s]+/, '');
}

/**
 * Inserts a "### Dependencies" block into the [Unreleased] section.
 *
 * Properties this must hold, each pinned by a test:
 *  - nothing to add leaves the text byte-identical
 *  - a package a human already named anywhere in [Unreleased] is skipped, never duplicated
 *  - injecting twice equals injecting once (the stability property conventions/README.md asks of
 *    any round-tripping pair)
 *
 * @param {string} changelogText
 * @param {{ name: string, from: string|null, to: string|null }[]} changes
 * @returns {string}
 */
export function injectDependencyNotes(changelogText, changes) {
  const lines = changelogText.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## [Unreleased]');
  if (start === -1) return changelogText;

  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith('## ['));
  if (end === -1) end = lines.length;

  const section = lines.slice(start + 1, end).join('\n');
  const fresh = changes.filter(({ name }) => !mentions(section, name));
  if (fresh.length === 0) return changelogText;

  const bullets = formatDependencyBullets(fresh).map((b) => `- ${b}`);

  const headingIdx = lines.findIndex(
    (l, i) => i > start && i < end && l.trim() === '### Dependencies'
  );

  if (headingIdx !== -1) {
    // Append to the existing block, just after its last bullet.
    let insertAt = headingIdx + 1;
    for (let i = headingIdx + 1; i < end; i += 1) {
      if (lines[i].trim().startsWith('### ')) break;
      if (lines[i].trim() !== '') insertAt = i + 1;
    }
    lines.splice(insertAt, 0, ...bullets);
    return lines.join('\n');
  }

  // New block, appended as the last subsection of [Unreleased].
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  const block = insertAt === start + 1
    ? ['', '### Dependencies', '', ...bullets, '']
    : ['', '### Dependencies', '', ...bullets];
  lines.splice(insertAt, 0, ...block);
  return lines.join('\n');
}

/**
 * True when the section already talks about this package, so a derived bullet would be a worse
 * duplicate of a human's entry. Matched on the bare name and the backticked name, case-insensitively.
 */
function mentions(section, name) {
  return section.toLowerCase().includes(name.toLowerCase());
}
