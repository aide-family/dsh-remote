#!/usr/bin/env bash
# Sync the working tree into the isolated development profile's node_modules.
#
# The DSH profile loader only routes `@deepseek-ai/*` imports for packages that
# physically live inside `<profile>/node_modules`; a `link:`/symlink to a
# directory outside the profile therefore cannot resolve them. Development uses
# this copy loop instead (production uses the packaged tarball).
#
#   ./scripts/sync-profile.sh [profile-name]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DSH_HOME="${DSH_DEV_HOME:-$REPO_DIR/.dsh-test}"
PROFILE="${1:-${PROFILE:-remotedev}}"
TARGET="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-remote"

if [ ! -d "$DSH_HOME/profiles/$PROFILE" ]; then
  echo "profile $PROFILE missing; run scripts/dev-profile.sh first" >&2
  exit 1
fi

mkdir -p "$TARGET"
# Runtime files only: no tests, docs, scripts, dev caches, or devDependencies.
rsync -a --delete \
  --exclude node_modules \
  --exclude test \
  --exclude docs \
  --exclude scripts \
  --exclude dist \
  --exclude package-lock.json \
  "$REPO_DIR/lib/" "$TARGET/lib/"
rsync -a "$REPO_DIR/package.json" "$REPO_DIR/cordis.patch.yml" "$TARGET/"

# The native-terminal launcher lives in the top-level bin/ directory (packaged
# via package.json "files"); keep the dev profile identical to a tarball
# install. Conditional so the script still works on a checkout without it.
if [ -d "$REPO_DIR/bin" ]; then
  mkdir -p "$TARGET/bin"
  rsync -a --delete "$REPO_DIR/bin/" "$TARGET/bin/"
fi

# Runtime dependencies (ssh2 and its transitive packages); devDependencies are
# deliberately excluded so the copy matches a production install.
if [ -d "$REPO_DIR/node_modules/ssh2" ]; then
  mkdir -p "$TARGET/node_modules"
  rsync -a --delete --exclude '@deepseek-ai' "$REPO_DIR/node_modules/" "$TARGET/node_modules/"
else
  echo "node_modules/ssh2 missing; run npm install in $REPO_DIR" >&2
  exit 1
fi

echo "synced $REPO_DIR -> $TARGET"
