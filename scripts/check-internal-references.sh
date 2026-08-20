#!/usr/bin/env bash
# Greps tracked source for terms that only make sense inside the private working repos
# (rulebeat/ops, the old azure-oss archive) and have no business in this public one: internal
# doc names, the employer name checked against at the 2026-08-17 IP review, local machine paths,
# and dangling references to directories (docs/qa/, docs/specs/, .claude/, etc.) that don't exist
# here at all.
#
# Report-only for now, not a merge gate: the 2026-08-20 repo split carried roughly 500 such
# references over in source comments, and per the standing repo-separation agreement those get
# swept by hand, not silently rewritten by a script. This job exists so the count is visible on
# every push instead of only being known from one manual pass. Once that sweep is done and the
# count is zero, flip `set -e` on / drop the `|| true` below so a regression fails CI.
#
# Usage: scripts/check-internal-references.sh

set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

TERMS=(
  'PRODUCT-PLAN'
  'LAUNCH-PLAN'
  'OPEN-ITEMS'
  'Sanofi'
  'abdo-dev'
  'codex-review'
  'docs/qa/'
  'docs/specs/'
  'docs/reviews/'
  'docs/strategy/'
  'docs/launch/'
  'docs/CHANGELOG'
  '\.claude/'
)

total=0
echo "Internal-reference scan (report-only, see script header):"
for term in "${TERMS[@]}"; do
  # -I skips binary files, -i case-insensitive, -c counts per file. Self-exclude this script and
  # its own workflow step, both of which necessarily name every term above.
  hits=$(git grep -Iic "$term" -- . \
    ':!scripts/check-internal-references.sh' \
    ':!.github/workflows/ci.yml' \
    2>/dev/null | awk -F: '{sum+=$2} END{print sum+0}')
  if [ "$hits" -gt 0 ]; then
    echo "  - ${hits} match(es) for \"${term}\""
    total=$((total + hits))
  fi
done

echo ""
if [ "$total" -eq 0 ]; then
  echo "No internal references found."
else
  echo "Total: ${total} internal reference(s) across the terms above. Not currently blocking (see script header)."
fi

exit 0
