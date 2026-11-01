#!/usr/bin/env bash
# Pack dsh-remote and install it into a DSH profile.
#
#   ./scripts/install-into-profile.sh [profile]      # default: desktop
#
# Why the tarball: a DSH profile only resolves `@deepseek-ai/*` imports for
# packages that physically live under `<profile>/node_modules`, so a `link:`
# symlink to this checkout cannot load. `--ignore-scripts` is required because
# pnpm 11 blocks ssh2's optional native build scripts; ssh2's pure-JavaScript
# implementation is fully functional, so the build is unnecessary.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-desktop}"

cd "$REPO_DIR"
if [ ! -d node_modules/ssh2 ]; then
  echo "installing dependencies..."
  npm install --no-audit --no-fund
fi

echo "packing dsh-remote..."
# Keep npm's cache inside the checkout: the harness file policy may not allow
# writes to ~/.npm from inside a session.
export npm_config_cache="${npm_config_cache:-$REPO_DIR/.cache/npm}"
mkdir -p "$npm_config_cache" dist
if ! PACK_OUT="$(npm pack --pack-destination dist 2>&1)"; then
  echo "$PACK_OUT" >&2
  exit 1
fi
TARBALL="$(printf '%s\n' "$PACK_OUT" | grep -E '\.tgz$' | tail -n 1)"
if [ -z "$TARBALL" ] || [ ! -f "$REPO_DIR/dist/$TARBALL" ]; then
  echo "npm pack failed: $PACK_OUT" >&2
  exit 1
fi
TARBALL_PATH="$REPO_DIR/dist/$TARBALL"
echo "built $TARBALL_PATH"

echo "installing into DSH profile '$PROFILE'..."
dsh plugin --profile "$PROFILE" add "file:$TARBALL_PATH" --ignore-scripts

cat <<EOF

Installed dsh-remote into profile '$PROFILE'.

Next step:
  - Desktop app: fully quit and reopen DeepSeek Harness (a profile reload is not
    enough on every build), then ask the agent: "Call remote_hosts".
  - CLI: run 'dsh --profile $PROFILE ...' (or 'dsh plugin --profile $PROFILE why dsh-remote').
EOF
