#!/bin/sh
# OpenBridge entrypoint — manages the volume overlay for self-updates.
#
# On first boot, copies the baked-in /app to the persistent volume.
# On subsequent boots, runs from the volume (which may have been self-updated).
# If the Docker image is newer than the volume version, re-copies from /app.

set -e

APP_VOLUME="/opt/openbridge"
APP_DIR="$APP_VOLUME/current"
BAKED_DIR="/app"
VERSION_FILE="$APP_VOLUME/version.json"
BAKED_VERSION="${OPENBRIDGE_VERSION:-0.0.0}"

should_bootstrap() {
  # No version file = first boot
  if [ ! -f "$VERSION_FILE" ]; then
    echo "First boot — initialising from Docker image v$BAKED_VERSION"
    return 0
  fi

  # Compare baked-in version with volume version
  VOLUME_VERSION=$(cat "$VERSION_FILE" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$VOLUME_VERSION" ]; then
    echo "Corrupt version file — re-initialising from Docker image"
    return 0
  fi

  # If baked-in image is newer, overwrite volume with image contents
  # Simple string comparison works for semver when format is consistent
  if [ "$BAKED_VERSION" != "$VOLUME_VERSION" ]; then
    # Use node for proper semver comparison
    IS_NEWER=$(node -e "
      const baked = '$BAKED_VERSION'.split('.').map(Number);
      const vol = '$VOLUME_VERSION'.split('.').map(Number);
      const newer = baked[0] > vol[0] || (baked[0] === vol[0] && baked[1] > vol[1]) || (baked[0] === vol[0] && baked[1] === vol[1] && baked[2] > vol[2]);
      process.stdout.write(newer ? 'yes' : 'no');
    ")
    if [ "$IS_NEWER" = "yes" ]; then
      echo "Docker image v$BAKED_VERSION is newer than volume v$VOLUME_VERSION — updating"
      return 0
    fi
  fi

  return 1
}

if should_bootstrap; then
  # Clean and copy
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  cp -a "$BAKED_DIR/." "$APP_DIR/"

  # Write version metadata
  cat > "$VERSION_FILE" <<EOF
{
  "version": "$BAKED_VERSION",
  "arch": "$(uname -m)",
  "source": "docker-image",
  "installedAt": "$(date -Iseconds)"
}
EOF
  echo "Initialised v$BAKED_VERSION on volume"
else
  VOLUME_VERSION=$(cat "$VERSION_FILE" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "Running from volume v$VOLUME_VERSION"
fi

# Fix node-pty spawn-helper permissions (needed after copy)
find "$APP_DIR/apps/daemon/node_modules" -name "spawn-helper" -exec chmod +x {} \; 2>/dev/null || true

# Launch the daemon from the volume
exec node "$APP_DIR/apps/daemon/dist/index.js"
