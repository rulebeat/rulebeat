#!/usr/bin/env bash
# Runs scripts/release.mjs for real against a scratch fixture repo, not a mock, the same
# real-execution-over-mocking pattern scripts/docker-smoke-test.sh uses for the Docker lifecycle.
# scripts/release-bump-changelog.test.mjs already covers bumpChangelog()'s text logic in isolation;
# this covers the parts that only show up when the whole script actually runs: npm's real bump
# arithmetic, package-lock.json ending up genuinely consistent (checked by running `npm ci` against
# the result), the git commit and annotated tag, and the dirty-working-tree refusal.
#
# Usage: scripts/release-smoke-test.sh

set -euo pipefail

SCRATCH="$(mktemp -d)"
log() { echo "[release-smoke-test] $*"; }
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)"

log "building a minimal fixture repo at $SCRATCH"
mkdir -p "$SCRATCH/packages/core" "$SCRATCH/packages/web"

write_pkg() {
  local path="$1" name="$2"
  cat > "$path" <<EOF
{
  "name": "$name",
  "version": "0.1.0",
  "private": true
}
EOF
}
write_pkg "$SCRATCH/package.json" "rulebeat-fixture"
write_pkg "$SCRATCH/packages/core/package.json" "@rulebeat-fixture/core"
write_pkg "$SCRATCH/packages/web/package.json" "@rulebeat-fixture/web"

cat > "$SCRATCH/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

### Fixed
- A fixture bug, standing in for a real one.

## [0.1.0] - 2026-08-22

First fixture release.

[Unreleased]: https://github.com/rulebeat/rulebeat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rulebeat/rulebeat/releases/tag/v0.1.0
EOF

(
  cd "$SCRATCH"
  git init -q
  git config user.email "smoke-test@example.com"
  git config user.name "release-smoke-test"
  git add -A
  git commit -q -m "fixture: initial state"
)

log "running release.mjs against the fixture (patch bump)"
RELEASE_SCRIPT_ROOT="$SCRATCH" node "$REPO_ROOT/scripts/release.mjs" patch

log "checking all three package.json files landed on the same bumped version"
for f in package.json packages/core/package.json packages/web/package.json; do
  v=$(node -e "console.log(require('$SCRATCH/$f').version)")
  if [[ "$v" != "0.1.1" ]]; then
    echo "[release-smoke-test] FAIL: $f has version $v, expected 0.1.1" >&2
    exit 1
  fi
done
log "all three package.json files agree: 0.1.1"

log "checking package-lock.json exists and npm ci succeeds against it"
if [[ ! -f "$SCRATCH/package-lock.json" ]]; then
  echo "[release-smoke-test] FAIL: no package-lock.json was written" >&2
  exit 1
fi
(cd "$SCRATCH" && npm ci --no-audit --no-fund >/dev/null)
log "npm ci succeeded against the regenerated lockfile"

log "checking CHANGELOG.md got a real dated header for 0.1.1, above the untouched 0.1.0 entry"
grep -q '^## \[0.1.1\] - [0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}$' "$SCRATCH/CHANGELOG.md"
grep -q 'A fixture bug, standing in for a real one.' "$SCRATCH/CHANGELOG.md"
grep -q '## \[0.1.0\] - 2026-08-22' "$SCRATCH/CHANGELOG.md"
log "CHANGELOG.md content correct"

log "checking the footer links were kept in sync with the new release"
grep -q '^\[Unreleased\]: https://github.com/rulebeat/rulebeat/compare/v0.1.1\.\.\.HEAD$' "$SCRATCH/CHANGELOG.md"
grep -q '^\[0.1.1\]: https://github.com/rulebeat/rulebeat/compare/v0.1.0\.\.\.v0.1.1$' "$SCRATCH/CHANGELOG.md"
grep -q '^\[0.1.0\]: https://github.com/rulebeat/rulebeat/releases/tag/v0.1.0$' "$SCRATCH/CHANGELOG.md"
log "CHANGELOG.md footer links correct"

log "checking a commit and an annotated tag were created"
(
  cd "$SCRATCH"
  [[ "$(git log -1 --pretty=%s)" == "release: v0.1.1" ]] || {
    echo "[release-smoke-test] FAIL: unexpected commit message" >&2
    exit 1
  }
  git rev-parse "v0.1.1" >/dev/null
  [[ "$(git cat-file -t v0.1.1)" == "tag" ]] || {
    echo "[release-smoke-test] FAIL: v0.1.1 is not an annotated tag" >&2
    exit 1
  }
)
log "commit and annotated tag both correct"

log "checking a dirty working tree makes the script refuse, unchanged"
echo "unrelated change" >> "$SCRATCH/packages/web/package.json.dirty-marker"
(cd "$SCRATCH" && git add -A)
before_head="$(cd "$SCRATCH" && git rev-parse HEAD)"
if RELEASE_SCRIPT_ROOT="$SCRATCH" node "$REPO_ROOT/scripts/release.mjs" patch 2>/dev/null; then
  echo "[release-smoke-test] FAIL: release.mjs should have refused on a dirty working tree" >&2
  exit 1
fi
after_head="$(cd "$SCRATCH" && git rev-parse HEAD)"
[[ "$before_head" == "$after_head" ]] || {
  echo "[release-smoke-test] FAIL: a commit was created despite the dirty tree" >&2
  exit 1
}
log "dirty-tree refusal correct, no commit was made"

log "all checks passed"
