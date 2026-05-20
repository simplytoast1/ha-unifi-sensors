// REST client for the UniFi Protect Integration API (v1).
//
// Endpoint contract is documented in the Ubiquiti Help Center
// ("Getting Started with the Official UniFi API") and the OpenAPI spec at
// https://apidoc-cdn.ui.com/protect/v7.1.46/integration.json.
//
// Key differences from the legacy /proxy/protect/api used by older
// Homebridge plugins:
//   - Authentication is a per-console API key (X-API-KEY header), no
//     username/password bootstrap, no CSRF dance, no cookies.
//   - Base path is /proxy/protect/integration/v1/* (the integration prefix
//     is what gates the official API; the legacy path is unaffected).
//   - Requests are not rate-limited by the cloud proxy when made directly
//     to the console over the LAN -- which is the whole reason this plugin
//     prefers local over api.ui.com.
//
// The client deliberately uses Node's built-in https module rather than
// fetch / undici. The UniFi console serves a self-signed certificate by
// default, and using https.request gives us a clean per-request way to
// disable cert validation without leaking it into other modules. No extra
// dependency required.

import * as https from 'node:https';
import { URL } from 'node:url';
import type { ProtectFob, ProtectMetaInfo, ProtectSensor } from './types';

/** Constructor options for the API client. */
export interface IntegrationApiClientOptions {
  /** Base URL of the console, e.g. https://nvr.example.com (no trailing
   *  slash needed). The /proxy/protect/integration/v1/ suffix is added
   *  internally. */
  host: string;
  /** Integration API key generated in the UniFi UI. Sent as X-API-KEY
   *  on every request. */
  apiKey: string;
  /** Set true only when the console has a publicly trusted cert. Defaults
   *  to false because the vast majority of installs use the factory
   *  self-signed cert. */
  rejectUnauthorized?: boolean;
  /** Per-request timeout. The default is generous because some Protect
   *  endpoints take a couple seconds when the NVR is busy. */
  timeoutMs?: number;
}

/**
 * Error thrown for any non-2xx response. Carries the HTTP status and raw
 * body so callers can surface a useful message (e.g. distinguish a 401
 * "bad API key" from a 5xx "console down").
 */
export class IntegrationApiError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'IntegrationApiError';
  }
}

/**
 * Thin REST client. Only exposes the endpoints we actually call so the
 * surface area stays small and the types stay tight.
 *
 * Not stateful beyond the immutable connection parameters: every request
 * opens its own HTTP connection. UniFi's keep-alive doesn't reliably play
 * well with self-signed-cert agents, and at the polling rates this plugin
 * uses the overhead is negligible.
 */
export class IntegrationApiClient {
  private readonly base: URL;
  private readonly apiKey: string;
  private readonly rejectUnauthorized: boolean;
  private readonly timeoutMs: number;

  constructor(opts: IntegrationApiClientOptions) {
    // Strip any trailing slashes so we always produce a clean base URL.
    const host = opts.host.trim().replace(/\/+$/, '');
    // The trailing slash on the path matters: new URL(relative, base) only
    // appends `relative` if the base ends with `/`.
    this.base = new URL(host + '/proxy/protect/integration/v1/');
    this.apiKey = opts.apiKey.trim();
    this.rejectUnauthorized = opts.rejectUnauthorized ?? false;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** WS URL for the device-state stream (sensor diffs etc.). */
  get devicesWebsocketUrl(): string {
    return this.makeWsUrl('subscribe/devices');
  }

  /** WS URL for the event-log stream (button presses, motion starts, ...).
   *  A separate channel from devicesWebsocketUrl with its own payload
   *  shapes. */
  get eventsWebsocketUrl(): string {
    return this.makeWsUrl('subscribe/events');
  }

  private makeWsUrl(suffix: string): string {
    const u = new URL(this.base.toString());
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString() + suffix;
  }

  /** Exposed so events.ts can mirror the same TLS choice. */
  get rejectUnauthorizedTls(): boolean {
    return this.rejectUnauthorized;
  }

  /** Exposed so events.ts can attach the same X-API-KEY header. */
  get apiKeyHeader(): string {
    return this.apiKey;
  }

  /** GET /v1/meta/info -- returns the Protect application version. We use
   *  it to (a) sanity-check the API key + connectivity at startup and
   *  (b) populate FirmwareRevision on every accessory. */
  async getMetaInfo(): Promise<ProtectMetaInfo> {
    return this.request<ProtectMetaInfo>('GET', 'meta/info');
  }

  /** GET /v1/sensors -- full list. Used at startup and as the polling
   *  fallback when the websocket isn't available. */
  async listSensors(): Promise<ProtectSensor[]> {
    // The spec says the response is an array but some console versions
    // wrap it under .data. Accept both rather than fail on a wrapped shape.
    const result = await this.request<ProtectSensor[] | { data?: ProtectSensor[] }>(
      'GET',
      'sensors',
    );
    if (Array.isArray(result)) {
      return result;
    }
    if (result && Array.isArray(result.data)) {
      return result.data;
    }
    return [];
  }

  /** GET /v1/sensors/{id} -- single sensor refresh. Currently unused by the
   *  platform (we re-list on poll), but kept here for future use cases like
   *  "click to refresh" or backfilling a single accessory after error. */
  async getSensor(id: string): Promise<ProtectSensor> {
    return this.request<ProtectSensor>('GET', `sensors/${encodeURIComponent(id)}`);
  }

  /** GET /v1/fobs -- list every paired key fob. Same polling cadence as
   *  sensors. Some firmware wraps the array under .data; tolerate both. */
  async listFobs(): Promise<ProtectFob[]> {
    const result = await this.request<ProtectFob[] | { data?: ProtectFob[] }>(
      'GET',
      'fobs',
    );
    if (Array.isArray(result)) {
      return result;
    }
    if (result && Array.isArray(result.data)) {
      return result.data;
    }
    return [];
  }

  /** GET /v1/fobs/{id} -- single fob refresh. Kept for symmetry with
   *  getSensor; not currently called by the platform. */
  async getFob(id: string): Promise<ProtectFob> {
    return this.request<ProtectFob>('GET', `fobs/${encodeURIComponent(id)}`);
  }

  /**
   * Low-level HTTP request helper. Wraps https.request in a Promise so the
   * rest of the codebase can use async/await without pulling in axios or
   * undici. Returns the decoded JSON on 2xx and throws IntegrationApiError
   * on anything else.
   */
  private request<T>(method: string, path: string): Promise<T> {
    const url = new URL(path, this.base);

    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          method,
          hostname: url.hostname,
          // Default to 443 when the URL has no explicit port (the local
          // console listens on 443 even when proxied through https).
          port: url.port || 443,
          path: url.pathname + url.search,
          headers: {
            // Canonical Ubiquiti spelling is X-API-KEY (uppercase). HTTP
            // headers are case-insensitive but staying canonical avoids
            // confusion when grepping logs / packet captures.
            'X-API-KEY': this.apiKey,
            'Accept': 'application/json',
            'User-Agent': 'homebridge-unifi-sensors',
          },
          rejectUnauthorized: this.rejectUnauthorized,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new IntegrationApiError(
                `${method} ${path} failed: HTTP ${status}`,
                status,
                body,
              ));
              return;
            }
            // 204 No Content -- not currently expected for the GET endpoints
            // we call, but be lenient rather than crash on an empty body.
            if (!body) {
              resolve(undefined as unknown as T);
              return;
            }
            try {
              resolve(JSON.parse(body) as T);
            } catch (err) {
              reject(new IntegrationApiError(
                `Failed to parse JSON from ${method} ${path}: ${(err as Error).message}`,
                status,
                body,
              ));
            }
          });
        },
      );

      // node sets 'timeout' but does NOT auto-destroy the request -- we
      // have to abort manually or the promise hangs.
      req.on('timeout', () => {
        req.destroy(new IntegrationApiError(`${method} ${path} timed out after ${this.timeoutMs}ms`));
      });
      req.on('error', (err) => {
        reject(new IntegrationApiError(`${method} ${path} failed: ${err.message}`));
      });
      req.end();
    });
  }
}
