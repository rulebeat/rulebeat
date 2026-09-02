#!/usr/bin/env bash
# Fails a pull request whose branch name, commit messages or description carry things that must
# not become part of this public repository: a branch named after the tool that produced it, a
# tool or model attribution line, or an agent session link. The rule, and why it exists, is in
# docs/engineering/how-changes-are-made.md under "Branches, commits and what becomes public".
#
# Only the pull request's own commits (base..head) and its description are read. Tracked files
# are not: the docs that state the rule necessarily spell out the forbidden strings, and
# scripts/check-internal-references.sh already sweeps file content for internal terms.
#
# Kept out of the workflow YAML so it can be run locally against any range, for example to check
# a branch before pushing it:
#   PR_HEAD_REF=$(git branch --show-current) BASE_SHA=origin/main HEAD_SHA=HEAD \
#     bash scripts/check-public-footprint.sh
#
# Usage: scripts/check-public-footprint.sh
#   env: PR_HEAD_REF, BASE_SHA, HEAD_SHA, PR_BODY (may be empty on a workflow_dispatch run)

set -euo pipefail

# Branch prefixes that name a tool rather than the change.
BRANCH_PATTERN='^(claude|codex|copilot|cursor|devin|aider|gemini)/'

# Lines that attribute the work to a tool or link to an agent session. Case-insensitive.
# Do not paste one of these into a commit message to explain the rule; point at the doc instead.
TEXT_PATTERN='Claude-Session|Co-Authored-By:.*(Claude|Codex|Copilot|Cursor|Devin|Aider|GPT|Gemini)|claude\.ai/code|Generated (by|with) \[?(Claude|Codex|Copilot|Cursor|Devin|Aider|ChatGPT|Gemini)'

fail=0

if [[ -n "${PR_HEAD_REF:-}" ]] && [[ "$PR_HEAD_REF" =~ $BRANCH_PATTERN ]]; then
  echo "::error::Branch '${PR_HEAD_REF}' is named after a tool. Name it after the change, as <type>/<topic>: docs/…, fix/…, feat/…, chore/…, refactor/…."
  fail=1
fi

if [[ -n "${BASE_SHA:-}" && -n "${HEAD_SHA:-}" ]]; then
  while IFS= read -r sha; do
    [[ -z "$sha" ]] && continue
    if git log -1 --format=%B "$sha" | grep -qiE "$TEXT_PATTERN"; then
      echo "::error::Commit ${sha} carries a tool attribution or session link in its message. Remove the trailer or footer (git commit --amend, or an interactive rebase) and push again."
      fail=1
    fi
  done < <(git rev-list "${BASE_SHA}..${HEAD_SHA}")
fi

if [[ -n "${PR_BODY:-}" ]] && grep -qiE "$TEXT_PATTERN" <<<"$PR_BODY"; then
  echo "::error::The pull request description carries a tool attribution or session link. Edit the description and remove it."
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo "See docs/engineering/how-changes-are-made.md, section \"Branches, commits and what becomes public\"."
  exit 1
fi

echo "Public footprint: branch name, commit messages and description are clean."
