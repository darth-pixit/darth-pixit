#!/usr/bin/env node
/*
 * Belt-and-suspenders fix for the Metro start crash.
 *
 * @react-native/community-cli-plugin reads three middleware functions
 * (communityMiddleware, indexPageMiddleware, devMiddleware) and passes them
 * straight into Metro's unstable_extraMiddleware array. If any of those is
 * undefined — which happens when the wrong version of
 * @react-native-community/cli-server-api gets hoisted — Metro crashes with
 *   TypeError: Cannot read properties of undefined (reading 'handle')
 *
 * Pinning cli-server-api to 14.1.0 fixes the root cause, but users sometimes
 * end up with a stale node_modules. This patch makes runServer.js defensive
 * so it never passes undefined into Metro, regardless of which cli-server-api
 * got installed.
 *
 * Runs as a postinstall step. Idempotent: safe to run multiple times.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  '@react-native',
  'community-cli-plugin',
  'dist',
  'commands',
  'start',
  'runServer.js',
);

if (!fs.existsSync(target)) {
  // community-cli-plugin not installed yet — nothing to patch.
  process.exit(0);
}

const src = fs.readFileSync(target, 'utf8');

const MARKER = '/* patched-metro-start */';
if (src.includes(MARKER)) {
  process.exit(0);
}

const ORIGINAL = `unstable_extraMiddleware: [
      communityMiddleware,
      _cliServerApi.indexPageMiddleware,
      middleware,
    ],`;

const PATCHED = `unstable_extraMiddleware: ${MARKER} [
      communityMiddleware,
      _cliServerApi.indexPageMiddleware,
      middleware,
    ].filter(Boolean),`;

if (!src.includes(ORIGINAL)) {
  console.warn(
    '[patch-metro-start] runServer.js did not match expected shape — ' +
      'skipping patch (React Native may have been upgraded).',
  );
  process.exit(0);
}

fs.writeFileSync(target, src.replace(ORIGINAL, PATCHED));
console.log('[patch-metro-start] runServer.js patched to filter undefined middleware');
