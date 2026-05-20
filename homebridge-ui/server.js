// Server-side bridge for the Homebridge Config UI.
//
// Homebridge Config UI X spawns this process when the user opens our
// plugin's settings page. The HTML in homebridge-ui/public/index.html
// calls back into here via `homebridge.request('/path', payload)` to
// fetch live data from the user's UniFi console.
//
// We deliberately reuse the SAME compiled IntegrationApiClient that the
// runtime plugin uses (from dist/) so the UI sees exactly what the
// plugin will see at runtime -- no separate fetch logic to drift out of
// sync.

'use strict';

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { IntegrationApiClient, IntegrationApiError } = require('../dist/unifi/client');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // Route registered as POST /discover from the client side.
    this.onRequest('/discover', this.discover.bind(this));

    // Signal to the parent process that we're ready to receive
    // requests. Without this the UI hangs forever waiting for us.
    this.ready();
  }

  /**
   * Fetch meta info + sensor list + fob list in parallel. Throws a
   * RequestError (which the framework propagates back to the browser as
   * a structured error) on any auth or network failure so the UI can
   * show a useful message.
   */
  async discover(payload) {
    const host = (payload && payload.host || '').trim();
    const apiKey = (payload && payload.apiKey || '').trim();
    if (!host || !apiKey) {
      throw new RequestError('Host and API key are required to discover devices.');
    }

    const client = new IntegrationApiClient({
      host,
      apiKey,
      rejectUnauthorized: !!(payload && payload.rejectUnauthorized),
      timeoutMs: 15_000,
    });

    try {
      const [meta, sensors, fobs] = await Promise.all([
        client.getMetaInfo(),
        client.listSensors(),
        client.listFobs(),
      ]);
      return { meta, sensors, fobs };
    } catch (err) {
      const e = /** @type {InstanceType<typeof IntegrationApiError>} */ (err);
      if (e && (e.status === 401 || e.status === 403)) {
        throw new RequestError(`UniFi rejected the API key (HTTP ${e.status}).`);
      }
      throw new RequestError(
        `Could not reach UniFi Protect at ${host}: ${e && e.message ? e.message : String(err)}`,
      );
    }
  }
}

// eslint-disable-next-line no-new
new UiServer();
