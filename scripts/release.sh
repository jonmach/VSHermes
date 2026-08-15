#!/usr/bin/env bash
# Release the current package.json version: tag, push, GitHub release,
# attach the vsix. Run on a clean tree after the version commit.
# Usage: ./scripts/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
REPO=jonmach/VSHermes
VSIX="dist/vsh-hermes-$VERSION.vsix"
# Paths that end up inside the vsix (bundled or shipped verbatim). If a
# rebase drifts any of these, the pre-built vsix is stale and must be
# rebuilt before attaching.
VSIX_INPUTS='^(src/|media/|package.json|esbuild.mjs|README.md|CHANGELOG.md|LICENSE)'

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty — commit first" >&2
  exit 1
fi

# Sync with the remote before anything else: a release is a point-in-time
# claim, so it must be based on the latest origin/main, not a stale local
# main. Fetch first so both the drift check and the tag check see the truth.
echo "==> fetching origin"
git fetch origin

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists (local or remote)" >&2
  exit 1
fi

# If origin/main has commits we don't, rebase onto it so the tag lands on
# the integrated tip and the push stays fast-forward. Abort cleanly on
# conflict — the user must resolve that by hand, we won't guess.
if [ -n "$(git rev-list HEAD..origin/main 2>/dev/null)" ]; then
  OLD_HEAD=$(git rev-parse HEAD)
  echo "==> rebasing onto origin/main"
  if ! git rebase origin/main; then
    git rebase --abort
    echo "error: rebase onto origin/main conflicted — resolve it manually, then re-run" >&2
    exit 1
  fi
  if git diff --name-only "$OLD_HEAD" HEAD | grep -qE "$VSIX_INPUTS"; then
    echo "==> drift changed vsix inputs — rebuilding $VSIX"
    npm run package >/dev/null
  else
    echo "==> drift touched no vsix inputs — keeping existing $VSIX"
  fi
fi

echo "==> tagging $TAG"
git tag "$TAG"
git push origin main
git push origin "$TAG"

TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p' | head -1 | tr -d '\r\n')
[ -n "$TOKEN" ] || { echo "error: no GitHub credential from git helper" >&2; exit 1; }

NOTES=$(awk -v v="$VERSION" 'BEGIN{found=0} /^## /{if(found) exit; if($0 ~ "^## " v " ") found=1; next} found{print}' CHANGELOG.md)
if [ -z "$NOTES" ]; then
  echo "error: no CHANGELOG section for $VERSION" >&2
  exit 1
fi

BODY=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<<"$NOTES")
echo "==> creating GitHub release $TAG"
RESP=$(curl -sS -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/releases" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"body\":$BODY}")
ID=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" <<<"$RESP")
[ -n "$ID" ] || { echo "release creation failed:" >&2; echo "$RESP" >&2; exit 1; }

if [ -f "$VSIX" ]; then
  echo "==> attaching $VSIX"
  curl -sS -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$(basename "$VSIX")" \
    --data-binary "@$VSIX" | python3 -c "import json,sys; d=json.load(sys.stdin); print('attached:', d.get('name'))"
else
  echo "==> no $VSIX to attach (build with: npm run package)"
fi
echo "done: https://github.com/$REPO/releases/tag/$TAG"
