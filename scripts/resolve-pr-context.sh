#!/usr/bin/env bash
#
# Resolves a pull request into the flat set of values check-changelog-entry.mjs reads, for both
# trigger shapes pr-checks.yml supports (a `pull_request` event, and the `workflow_dispatch`
# prepare-release.yml uses against its own release PR).
#
# This lives in a script rather than inline in the workflow so it can be tested. It was inline
# once, and the bug that put it here is worth stating plainly:
#
#   `toJSON(...)` PRETTY-PRINTS across multiple lines. A single label rendered as
#
#       labels=[
#         "dependencies"
#       ]
#
#   and $GITHUB_OUTPUT's key=value form accepts single-line values only, so the runner rejected the
#   whole step with `Invalid format '  "dependencies"'` before the checker ever ran. It stayed
#   invisible while every PR had zero labels (toJSON([]) is one line), then broke every Dependabot
#   PR at once when dependabot.yml started applying `dependencies`. Worse, it took the escape hatch
#   down with it: applying `no-changelog` is itself what produces a multi-line value, so the label
#   that is supposed to unblock a PR guaranteed the check would fail.
#
# Hence: every value is read with `jq`, and the array with `jq -c`, which cannot emit a multi-line
# value whatever a label happens to contain. Reading the payload with jq instead of interpolating
# it with ${{ }} also keeps attacker-controlled text (a fork's branch name, a label) out of the
# shell entirely.
#
# Reads:  GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_OUTPUT, PR_NUMBER, GH_TOKEN
# Writes: base_sha, head_sha, head_ref, head_repo, author, labels -> $GITHUB_OUTPUT
set -euo pipefail

if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
  JSON=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}")
else
  JSON=$(jq -c '.pull_request' "$GITHUB_EVENT_PATH")
fi

if [[ "$(jq -r 'if . == null then "null" else "ok" end' <<<"$JSON")" != "ok" ]]; then
  echo "::error::Could not resolve the pull request payload." >&2
  exit 2
fi

{
  echo "base_sha=$(jq -r '.base.sha' <<<"$JSON")"
  echo "head_sha=$(jq -r '.head.sha' <<<"$JSON")"
  echo "head_ref=$(jq -r '.head.ref' <<<"$JSON")"
  echo "head_repo=$(jq -r '.head.repo.full_name' <<<"$JSON")"
  echo "author=$(jq -r '.user.login' <<<"$JSON")"
  echo "labels=$(jq -c '[.labels[].name]' <<<"$JSON")"
} >> "$GITHUB_OUTPUT"
