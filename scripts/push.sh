#!/usr/bin/env bash
# Commit everything and push to GitHub.
#
#   ./scripts/push.sh "commit subject"
#   ./scripts/push.sh -F path/to/message.txt
#
# Authentication comes from the gh CLI's keyring, fetched inline for the single
# push. Nothing is written to .git/config and no token is ever stored in the
# working tree, so there is no credentials file to leak or to keep in sync.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPO="jeffkoskulics/longshot"
BRANCH="${BRANCH:-main}"
GH="$HOME/bin/gh"
[ -x "$GH" ] || GH="$(command -v gh || true)"

if [ -z "$GH" ]; then
  echo "error: gh CLI not found (expected ~/bin/gh)" >&2
  exit 1
fi

if [ "${1:-}" = "-F" ]; then
  [ -f "${2:-}" ] || { echo "error: message file not found" >&2; exit 2; }
  COMMIT_ARGS=(-F "$2")
elif [ -n "${1:-}" ]; then
  COMMIT_ARGS=(-m "$1")
else
  echo "usage: push.sh \"commit subject\" | -F messagefile" >&2
  exit 2
fi

git config user.name  "Jeff Koskulics"
git config user.email "jeffkoskulics@gmail.com"

git add -A
git update-index --chmod=+x scripts/push.sh tests/run.sh serve.command 2>/dev/null || true

if git diff --cached --quiet && git rev-parse HEAD >/dev/null 2>&1; then
  echo "==> nothing to commit"
else
  git commit -q "${COMMIT_ARGS[@]}"
fi

TOKEN="$("$GH" auth token)"
[ -n "$TOKEN" ] || { echo "error: gh has no token; run: gh auth login" >&2; exit 1; }
scrub() { sed "s#${TOKEN}#***#g"; }

echo "==> pushing to $REPO ($BRANCH)"
git push "https://x-access-token:${TOKEN}@github.com/${REPO}.git" "HEAD:$BRANCH" 2>&1 | scrub
git --no-pager log --oneline -1
