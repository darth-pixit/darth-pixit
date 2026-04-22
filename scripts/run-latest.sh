#!/usr/bin/env bash
set -euo pipefail

# Pull latest main, reinstall deps if needed, then launch on device.
# Run from the repo root: ./scripts/run-latest.sh

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Pulling latest main…"
git fetch origin main
git checkout main
git merge --ff-only origin/main

# Reinstall JS deps only if package.json changed since last install.
if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-install-stamp ]; then
  echo "==> npm install…"
  npm install
  touch node_modules/.package-install-stamp
fi

# Re-run pod install only if the Podfile or any native dep changed.
if [ ios/Podfile -nt ios/Pods/.pod-install-stamp ] || \
   [ package.json -nt ios/Pods/.pod-install-stamp ]; then
  echo "==> pod install…"
  cd ios && pod install && cd ..
  touch ios/Pods/.pod-install-stamp
fi

echo "==> Starting Metro + running on device…"
echo "    (keep this terminal open; press Ctrl+C to stop)"
npx react-native run-ios --device
