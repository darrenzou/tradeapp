#!/bin/bash
# Installs Ghidra for rea's native analysis (decompiling compiled programs) in a cloud session.
# rea 6.4.0 needs Ghidra 12.1.x and a JDK 21+, which the cloud image already has.
# Keep the path in sync with GHIDRA_INSTALL_DIR in .mcp.json.
set -euo pipefail

VERSION=12.1.4
DATE=20260921
SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
DEST=/opt/ghidra_${VERSION}_PUBLIC

if [ -x "$DEST/support/analyzeHeadless" ]; then
  echo "Ghidra $VERSION already installed at $DEST"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/ghidra.zip" \
  "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${VERSION}_build/ghidra_${VERSION}_PUBLIC_${DATE}.zip"
echo "$SHA256  $tmp/ghidra.zip" | sha256sum -c -
unzip -q "$tmp/ghidra.zip" -d /opt
echo "Ghidra $VERSION installed at $DEST"
