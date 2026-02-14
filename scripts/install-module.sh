#!/bin/bash
# Install the Magi Bridge module into a Foundry VTT installation.
# Usage: ./scripts/install-module.sh /path/to/foundry/Data
#
# This creates a symlink from Foundry's modules directory to the module source.

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <foundry-data-dir>"
  echo "  e.g.: $0 /home/user/foundrydata"
  echo "  e.g.: $0 ~/.local/share/FoundryVTT/Data"
  exit 1
fi

FOUNDRY_DATA="$1"
MODULE_SRC="$(cd "$(dirname "$0")/../src/video/foundry-module" && pwd)"
MODULE_DEST="$FOUNDRY_DATA/modules/magi-bridge"

if [ ! -d "$FOUNDRY_DATA/modules" ]; then
  echo "Error: $FOUNDRY_DATA/modules does not exist."
  echo "Is '$FOUNDRY_DATA' the correct Foundry Data directory?"
  exit 1
fi

if [ -L "$MODULE_DEST" ]; then
  echo "Symlink already exists: $MODULE_DEST -> $(readlink "$MODULE_DEST")"
  echo "Updating..."
  rm "$MODULE_DEST"
elif [ -d "$MODULE_DEST" ]; then
  echo "Warning: $MODULE_DEST exists as a directory (not a symlink)."
  echo "Remove it manually if you want to use the symlink approach."
  exit 1
fi

ln -s "$MODULE_SRC" "$MODULE_DEST"
echo "Installed: $MODULE_DEST -> $MODULE_SRC"
echo ""
echo "Next steps:"
echo "  1. Restart Foundry VTT (or refresh the browser)"
echo "  2. Go to Configuration > Manage Modules > enable 'Magi Bridge'"
echo "  3. Configure the sidecar URL and auth token in Module Settings"
