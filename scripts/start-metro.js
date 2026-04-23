#!/usr/bin/env node
/*
 * Direct Metro invocation, bypassing @react-native/community-cli-plugin.
 *
 * Why: community-cli-plugin builds an unstable_extraMiddleware array from
 * three separate package resolutions (cli-server-api, dev-middleware,
 * cli-server-api again). When any one resolves to undefined in a given
 * node_modules state, Metro crashes at connect's serverApp.use(undefined)
 * with:
 *   TypeError: Cannot read properties of undefined (reading 'handle')
 *
 * This script does what runServer.js does, but defensively: every
 * middleware load is wrapped in try/catch, any undefined entry is filtered
 * out, and the result is passed to Metro.runServer directly. Bootable
 * even if cli-server-api or dev-middleware are entirely missing.
 */
const Metro = require('metro');
const { loadConfig } = require('metro-config');

async function main() {
  const config = await loadConfig({ cwd: process.cwd() });
  const port = config.server.port || 8081;
  const host = process.env.RCT_METRO_HOST || '0.0.0.0';
  const serverBaseUrl = `http://${host}:${port}`;

  const extraMiddleware = [];
  let communityWebsocketEndpoints = {};
  let messageSocketEndpoint;

  try {
    const cliServerApi = require('@react-native-community/cli-server-api');
    if (typeof cliServerApi.createDevServerMiddleware === 'function') {
      const dev = cliServerApi.createDevServerMiddleware({
        host,
        port,
        watchFolders: config.watchFolders || [],
      });
      if (dev.middleware) extraMiddleware.push(dev.middleware);
      if (dev.websocketEndpoints) communityWebsocketEndpoints = dev.websocketEndpoints;
      messageSocketEndpoint = dev.messageSocketEndpoint;
    }
    if (typeof cliServerApi.indexPageMiddleware === 'function') {
      extraMiddleware.push(cliServerApi.indexPageMiddleware);
    }
  } catch (e) {
    console.warn('[start-metro] cli-server-api middleware unavailable:', e.message);
  }

  try {
    let createDevMiddleware;
    try {
      ({ createDevMiddleware } = require('@react-native/dev-middleware'));
    } catch {
      // Often only installed nested under community-cli-plugin.
      const nested = require.resolve(
        '@react-native/dev-middleware',
        { paths: [require.resolve('@react-native/community-cli-plugin/package.json')] }
      );
      ({ createDevMiddleware } = require(nested));
    }
    if (typeof createDevMiddleware === 'function') {
      const dm = createDevMiddleware({
        projectRoot: config.projectRoot,
        serverBaseUrl,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      if (dm.middleware) extraMiddleware.push(dm.middleware);
    }
  } catch (e) {
    console.warn('[start-metro] dev-middleware unavailable:', e.message);
  }

  const finalMiddleware = extraMiddleware.filter(Boolean);

  console.log(`[start-metro] Metro on ${serverBaseUrl} (${finalMiddleware.length} middleware)`);

  const server = await Metro.runServer(config, {
    host,
    port,
    unstable_extraMiddleware: finalMiddleware,
    websocketEndpoints: communityWebsocketEndpoints,
  });

  server.keepAliveTimeout = 30000;

  process.on('SIGINT', () => {
    console.log('\n[start-metro] shutting down');
    server.close(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('[start-metro] failed to start:', err);
  process.exit(1);
});
