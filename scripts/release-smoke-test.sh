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

# Docs with image references, one floating and one stale-pinned: release.mjs must rewrite both
# to the new version inside the release commit (pinImageTags). The atomic and deps fixtures
# below carry no docs at all, which covers the docs-are-optional path.
cat > "$SCRATCH/README.md" <<'EOF'
Run `docker run ghcr.io/rulebeat/rulebeat:latest` to start.
EOF
mkdir -p "$SCRATCH/docs/public"
cat > "$SCRATCH/docs/public/install.md" <<'EOF'
docker run ghcr.io/rulebeat/rulebeat:0.1.0
EOF

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

log "checking doc image references were pinned to the new version, inside the release commit"
grep -q 'ghcr.io/rulebeat/rulebeat:0.1.1' "$SCRATCH/README.md"
grep -q 'ghcr.io/rulebeat/rulebeat:0.1.1' "$SCRATCH/docs/public/install.md"
if grep -Eq 'rulebeat:(latest|0\.1\.0)' "$SCRATCH/README.md" "$SCRATCH/docs/public/install.md"; then
  echo "[release-smoke-test] FAIL: a doc still references :latest or the stale pin" >&2
  exit 1
fi
if [[ -n "$(cd "$SCRATCH" && git status --porcelain)" ]]; then
  echo "[release-smoke-test] FAIL: the doc rewrites were left uncommitted" >&2
  exit 1
fi
log "doc image references pinned and committed"

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

# --------------------------------------------------------------------------------------------
# Atomicity: a refusal must change NOTHING. release.mjs used to run `npm version`, rewrite both
# workspace manifests and regenerate the lockfile BEFORE it ever read CHANGELOG.md, so an empty
# [Unreleased] aborted with a half-bumped tree -- while how-changes-are-made.md claimed it "changes
# nothing when it refuses". These scenarios assert the files are byte-identical afterwards.
# --------------------------------------------------------------------------------------------

ATOMIC="$(mktemp -d)"
cleanup_atomic() { rm -rf "$ATOMIC"; }
trap 'cleanup; cleanup_atomic' EXIT

build_atomic_fixture() {
  local changelog_body="$1"
  rm -rf "${ATOMIC:?}"/*
  mkdir -p "$ATOMIC/packages/core" "$ATOMIC/packages/web"
  write_pkg "$ATOMIC/package.json" "rulebeat-fixture"
  write_pkg "$ATOMIC/packages/core/package.json" "@rulebeat-fixture/core"
  write_pkg "$ATOMIC/packages/web/package.json" "@rulebeat-fixture/web"
  printf '%s\n' "$changelog_body" > "$ATOMIC/CHANGELOG.md"
  (
    cd "$ATOMIC"
    git init -q
    git config user.email "smoke-test@example.com"
    git config user.name "release-smoke-test"
    git add -A
    git commit -q -m "fixture: initial state"
  )
}

assert_unchanged() {
  local label="$1"
  local before_head after_head dirty
  before_head="$(cd "$ATOMIC" && git rev-parse HEAD)"
  if RELEASE_SCRIPT_ROOT="$ATOMIC" node "$REPO_ROOT/scripts/release.mjs" patch >/dev/null 2>&1; then
    echo "[release-smoke-test] FAIL: $label -- release.mjs should have refused" >&2
    exit 1
  fi
  after_head="$(cd "$ATOMIC" && git rev-parse HEAD)"
  [[ "$before_head" == "$after_head" ]] || {
    echo "[release-smoke-test] FAIL: $label -- HEAD moved" >&2
    exit 1
  }
  dirty="$(cd "$ATOMIC" && git status --porcelain)"
  [[ -z "$dirty" ]] || {
    echo "[release-smoke-test] FAIL: $label -- refusal left the tree modified:" >&2
    echo "$dirty" >&2
    exit 1
  }
  log "$label: refused, tree byte-identical, HEAD unchanged"
}

log "checking an EMPTY [Unreleased] refuses atomically"
build_atomic_fixture '# Changelog

## [Unreleased]

## [0.1.0] - 2026-08-22

First fixture release.'
assert_unchanged "empty [Unreleased]"

log "checking a MISSING [Unreleased] header refuses atomically"
build_atomic_fixture '# Changelog

## [0.1.0] - 2026-08-22

First fixture release.'
assert_unchanged "missing [Unreleased] header"

log "checking an [Unreleased] with prose but no bullets refuses atomically"
build_atomic_fixture '# Changelog

## [Unreleased]

Nothing here is a bullet, so there is nothing to release.

## [0.1.0] - 2026-08-22

First fixture release.'
assert_unchanged "[Unreleased] with no bullets"

# --------------------------------------------------------------------------------------------
# Dependency notes derived from repository state. The fixture above has no tags, which exercises
# the first-release path; this one has a real v0.1.0 tag, which is the normal case: the notes are
# diffed between that tag's manifests and the working tree's.
# --------------------------------------------------------------------------------------------

DEPS="$(mktemp -d)"
cleanup_deps() { rm -rf "$DEPS"; }
trap 'cleanup; cleanup_atomic; cleanup_deps' EXIT

log "checking dependency notes are derived from the manifests between releases"
mkdir -p "$DEPS/packages/core" "$DEPS/packages/web"
write_pkg "$DEPS/package.json" "rulebeat-fixture"
cat > "$DEPS/packages/core/package.json" <<'EOF'
{
  "name": "@rulebeat-fixture/core",
  "version": "0.1.0",
  "private": true,
  "dependencies": { "left-pad": "^1.0.0" }
}
EOF
cat > "$DEPS/packages/web/package.json" <<'EOF'
{
  "name": "@rulebeat-fixture/web",
  "version": "0.1.0",
  "private": true,
  "dependencies": { "right-pad": "^2.0.0" },
  "devDependencies": { "vitest": "^4.0.0" }
}
EOF
cat > "$DEPS/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

### Fixed
- A fixture bug.

## [0.1.0] - 2026-08-22

First fixture release.
EOF
(
  cd "$DEPS"
  git init -q
  git config user.email "smoke-test@example.com"
  git config user.name "release-smoke-test"
  git add -A
  git commit -q -m "fixture: initial state"
  git tag -a v0.1.0 -m v0.1.0
)

# Bump a runtime dependency and a devDependency; only the runtime one should be reported.
python3 - "$DEPS" <<'PYEOF'
import json, sys, pathlib
root = pathlib.Path(sys.argv[1])
core = json.loads((root / "packages/core/package.json").read_text())
core["dependencies"]["left-pad"] = "^1.3.0"
(root / "packages/core/package.json").write_text(json.dumps(core, indent=2) + "\n")
web = json.loads((root / "packages/web/package.json").read_text())
web["devDependencies"]["vitest"] = "^4.9.9"
(root / "packages/web/package.json").write_text(json.dumps(web, indent=2) + "\n")
PYEOF
(cd "$DEPS" && git add -A && git commit -q -m "build(deps): bump left-pad and vitest")

RELEASE_SCRIPT_ROOT="$DEPS" node "$REPO_ROOT/scripts/release.mjs" patch >/dev/null

grep -q '^### Dependencies$' "$DEPS/CHANGELOG.md" || {
  echo "[release-smoke-test] FAIL: no Dependencies block was derived" >&2; exit 1; }
grep -q 'left-pad.*1\.0\.0 to 1\.3\.0' "$DEPS/CHANGELOG.md" || {
  echo "[release-smoke-test] FAIL: the runtime bump was not described" >&2; exit 1; }
if grep -q 'vitest' "$DEPS/CHANGELOG.md"; then
  echo "[release-smoke-test] FAIL: a devDependency reached the release notes" >&2; exit 1
fi
# It must land in the released section, not the fresh empty [Unreleased] left behind.
awk '/^## \[0.1.1\]/{f=1} /^## \[0.1.0\]/{f=0} f' "$DEPS/CHANGELOG.md" | grep -q '### Dependencies' || {
  echo "[release-smoke-test] FAIL: Dependencies landed outside the released section" >&2; exit 1; }
log "dependency notes derived correctly, devDependencies excluded"

log "all checks passed"
