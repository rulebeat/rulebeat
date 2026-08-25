#!/usr/bin/env bash
#
# Makes `origin/main` usable for `git merge-base origin/main HEAD` inside a CI job.
#
# Two separate things have to be true, and a default actions/checkout gives neither: the
# remote-tracking ref refs/remotes/origin/main has to EXIST, and it has to share history with the
# current branch. checkout fetches a single ref at depth 1, so main is not a ref at all and there is
# no common ancestor to find.
#
# This lives in a script because the inline version was wrong and untestable. It ran
#
#     git fetch origin main --depth=0 2>/dev/null || git fetch origin main
#
# where `--depth=0` is not valid for git fetch at all (--depth is a git CLONE option, and fetch
# rejects 0), 2>/dev/null swallowed that, and the fallback `git fetch origin main` populates
# FETCH_HEAD without ever creating refs/remotes/origin/main. The release candidate check then died
# with "fatal: Not a valid object name origin/main" on the first real release it ever ran against.
#
# The explicit refspec is what creates the ref. --unshallow is what supplies the history, and is
# applied only when the clone is actually shallow, because git refuses it on a complete repository.
set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-main}"
REFSPEC="+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}"

if [ -f "$(git rev-parse --git-dir)/shallow" ]; then
  git fetch --unshallow "$REMOTE" "$REFSPEC"
else
  git fetch "$REMOTE" "$REFSPEC"
fi

# Fail here with something readable rather than letting the checker die on a git plumbing error.
if ! git rev-parse --verify --quiet "${REMOTE}/${BRANCH}" >/dev/null; then
  echo "::error::${REMOTE}/${BRANCH} still does not exist after fetching. The candidate check cannot run." >&2
  exit 1
fi
if ! git merge-base "${REMOTE}/${BRANCH}" HEAD >/dev/null 2>&1; then
  echo "::error::No common ancestor between ${REMOTE}/${BRANCH} and HEAD. The clone is still too shallow." >&2
  exit 1
fi
