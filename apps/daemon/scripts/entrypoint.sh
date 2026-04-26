#!/bin/sh
# OpenBridge entrypoint — manages the volume overlay for self-updates.
#
# On first boot, copies the baked-in /app to the persistent volume.
# On subsequent boots, runs from the volume (which may have been self-updated).
# If the Docker image has a different build hash, re-copies from /app
# (unless the volume was self-updated to a newer version).

set -e

APP_VOLUME="/opt/openbridge"
APP_DIR="$APP_VOLUME/current"
BAKED_DIR="/app"
VERSION_FILE="$APP_VOLUME/version.json"
BAKED_VERSION="${OPENBRIDGE_VERSION:-0.0.0}"
BAKED_HASH="${OPENBRIDGE_BUILD_HASH:-unknown}"

should_bootstrap() {
  # No version file = first boot
  if [ ! -f "$VERSION_FILE" ]; then
    echo "First boot — initialising from Docker image v$BAKED_VERSION ($BAKED_HASH)"
    return 0
  fi

  VOLUME_VERSION=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf8'));process.stdout.write(j.version||'')}catch{}")
  VOLUME_HASH=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf8'));process.stdout.write(j.buildHash||'')}catch{}")
  VOLUME_SOURCE=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf8'));process.stdout.write(j.source||'')}catch{}")

  if [ -z "$VOLUME_VERSION" ]; then
    echo "Corrupt version file — re-initialising from Docker image"
    return 0
  fi

  # If the volume was self-updated, only overwrite if the baked-in version is strictly newer
  if [ "$VOLUME_SOURCE" = "self-update" ]; then
    IS_NEWER=$(node -e "
      const baked = '$BAKED_VERSION'.split('.').map(Number);
      const vol = '$VOLUME_VERSION'.split('.').map(Number);
      const newer = baked[0] > vol[0] || (baked[0] === vol[0] && baked[1] > vol[1]) || (baked[0] === vol[0] && baked[1] === vol[1] && baked[2] > vol[2]);
      process.stdout.write(newer ? 'yes' : 'no');
    ")
    if [ "$IS_NEWER" = "yes" ]; then
      echo "Docker image v$BAKED_VERSION is newer than self-updated v$VOLUME_VERSION — updating"
      return 0
    fi
    echo "Running from self-updated volume v$VOLUME_VERSION"
    return 1
  fi

  # For docker-image sourced volumes: re-copy if build hash differs
  if [ "$BAKED_HASH" != "unknown" ] && [ "$BAKED_HASH" != "$VOLUME_HASH" ]; then
    echo "Docker image build changed ($BAKED_HASH vs $VOLUME_HASH) — updating volume"
    return 0
  fi

  return 1
}

if should_bootstrap; then
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  cp -a "$BAKED_DIR/." "$APP_DIR/"

  cat > "$VERSION_FILE" <<EOF
{
  "version": "$BAKED_VERSION",
  "buildHash": "$BAKED_HASH",
  "arch": "$(uname -m)",
  "source": "docker-image",
  "installedAt": "$(date -Iseconds)"
}
EOF
  echo "Initialised v$BAKED_VERSION ($BAKED_HASH) on volume"
else
  VOLUME_VERSION=$(cat "$VERSION_FILE" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "Running from volume v$VOLUME_VERSION"
fi

# Fix node-pty spawn-helper permissions
find "$APP_DIR/apps/daemon/node_modules" -name "spawn-helper" -exec chmod +x {} \; 2>/dev/null || true

exec node "$APP_DIR/apps/daemon/dist/index.js"
