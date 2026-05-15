#!/usr/bin/env bash
# Prints SHA-1 and SHA-256 fingerprints for the keystore that signs this app.
# Register both in Firebase Console > Project Settings > Android app > "Add fingerprint",
# then re-download google-services.json. This is required for Firebase Phone Auth on
# Android (Play Integrity check) — without it, signInWithPhoneNumber fails with
# "auth/missing-client-identifier".
#
# Usage:
#   ./scripts/print-firebase-shas.sh                                 # debug.keystore
#   ./scripts/print-firebase-shas.sh path/to/release.jks ALIAS PASS  # release keystore
set -euo pipefail

KEYSTORE="${1:-android/app/debug.keystore}"
ALIAS="${2:-androiddebugkey}"
STORE_PASS="${3:-android}"
KEY_PASS="${4:-$STORE_PASS}"

if ! command -v keytool >/dev/null 2>&1; then
  echo "ERROR: keytool not found. Install a JDK (e.g. 'brew install --cask temurin')." >&2
  exit 1
fi

if [ ! -f "$KEYSTORE" ]; then
  echo "ERROR: keystore not found: $KEYSTORE" >&2
  exit 1
fi

echo "Keystore : $KEYSTORE"
echo "Alias    : $ALIAS"
echo
keytool -list -v \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -storepass "$STORE_PASS" \
  -keypass "$KEY_PASS" 2>/dev/null \
  | grep -E "SHA1:|SHA256:" \
  | sed 's/^[[:space:]]*//'

cat <<EOF

Next steps:
  1. Open Firebase Console > Project Settings > General
  2. Find the Android app for package com.darth.pixit
  3. Click "Add fingerprint" and paste the SHA-1 above. Repeat for SHA-256.
  4. Click "Download google-services.json" and replace android/app/google-services.json.
  5. Rebuild the APK and try Send OTP again.
EOF
