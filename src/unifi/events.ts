// Device-state subscriber for UniFi Protect /v1/subscribe/devices.
//
// The endpoint streams add / update / remove diffs for every Protect-managed
// device the console knows about. We subscribe once and emit per-type:
//
//   - 'snapshot'    : full list of sensors (after a REST poll)
//   - 'update'      : single (possibly partial) sensor
//   - 'fobSnapshot' : full list of fobs (after a REST poll)
//   - 'fobUpdate'   : single (possibly partial) fob
//
// We deliberately use ONE websocket for both device types: opening two
// would double the connection count for no win, and the spec's payload
// shape is already discriminated by `modelKey`. The polling fallback
// also handles both types in the same tick.
//
// Naming note: this file is called `events.ts` for historical reasons.
// It is the *device-state* stream, distinct from `event-stream.ts` which
// listens on /v1/subscribe/events for discrete event-log records (button
// presses, motion events, etc.). Don't confuse the two.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from 'homebridge';
import { IntegrationApiClient } from './client';
import type { ProtectFob, ProtectSensor } from './types';
import { wsDataToUtf8 } from './ws-decode';

/** Partial sensor shape delivered by the websocket. Only id is guaranteed;
 *  every other field is "may be present, may have changed". Consumers must
 *  merge into existing state rather than treat this as a full sensor. */
export type SensorPartial = Partial<ProtectSensor> & { id: string; modelKey?: string };

/** Same idea for fobs: id is always present, everything else may be. */
export type FobPartial = Partial<ProtectFob> & { id: string; modelKey?: string };

/** Emitted on every individual sensor change. */
export interface SensorUpdate {
  sensor: SensorPartial;
  source: 'websocket' | 'poll';
}

/** Emitted on every individual fob change. */
export interface FobUpdate {
  fob: FobPartial;
  source: 'websocket' | 'poll';
}

export interface SensorEventStreamOptions {
  client: IntegrationApiClient;
  log: Logger;
  pollIntervalSeconds: number;
  preferWebsocket: boolean;
}

// Strongly-typed EventEmitter events for clarity at call sites.
type SensorEventStreamEvents = {
  update: [SensorUpdate];
  snapshot: [ProtectSensor[]];
  fobUpdate: [FobUpdate];
  fobSnapshot: [ProtectFob[]];
  error: [Error];
};

/**
 * Hybrid websocket + polling subscriber for the device-state channel.
 * Tracks both sensors and fobs since they share the same endpoint.
 */
export class SensorEventStream extends EventEmitter<SensorEventStreamEvents> {
  private readonly client: IntegrationApiClient;
  private readonly log: Logger;
  private readonly pollIntervalMs: number;
  private readonly preferWebsocket: boolean;

  private ws?: WebSocket;
  private pollTimer?: NodeJS.Timeout;
  /** Pending reconnect, if any. Stored on the instance so stop() can
   *  cancel it; otherwise the Node event loop is kept alive for up to
   *  60s after Homebridge shutdown waiting for a reconnect that will
   *  immediately be no-op'd by `stopped`. */
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private wsReconnectAttempts = 0;

  constructor(opts: SensorEventStreamOptions) {
    super();
    this.client = opts.client;
    this.log = opts.log;
    this.pollIntervalMs = Math.max(1, opts.pollIntervalSeconds) * 1000;
    this.preferWebsocket = opts.preferWebsocket;
  }

  /** Boot order matters: we always run initial snapshot polls first so the
   *  rest of the plugin has a baseline state before any websocket diff
   *  lands. Without it the first few diffs would be discarded ("no handler
   *  for the id yet" -> refetch loop). */
  async start(): Promise<void> {
    await Promise.all([this.fetchSensorSnapshot(), this.fetchFobSnapshot()]);
    if (this.preferWebsocket) {
      this.connectWebsocket();
    }
    this.startPollLoop();
  }

  /** Called on Homebridge shutdown. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore; we're tearing down anyway
      }
      this.ws = undefined;
    }
  }

  /** Fetch the full sensor list and emit it as a snapshot. */
  private async fetchSensorSnapshot(): Promise<void> {
    try {
      const sensors = await this.client.listSensors();
      this.emit('snapshot', sensors);
    } catch (err) {
      this.log.debug(`Failed to fetch sensor snapshot: ${(err as Error).message}`);
      this.emit('error', err as Error);
    }
  }

  /** Fetch the full fob list and emit it as a fob snapshot. Same error
   *  policy as sensors: log + emit 'error' but never throw. */
  private async fetchFobSnapshot(): Promise<void> {
    try {
      const fobs = await this.client.listFobs();
      this.emit('fobSnapshot', fobs);
    } catch (err) {
      this.log.debug(`Failed to fetch fob snapshot: ${(err as Error).message}`);
      this.emit('error', err as Error);
    }
  }

  /** Background poll loop. Skips the poll when the websocket is healthy so
   *  we don't pull state we already have via push. Refreshes both sensors
   *  and fobs in one tick. */
  private startPollLoop(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return;
      }
      void this.fetchSensorSnapshot();
      void this.fetchFobSnapshot();
    }, this.pollIntervalMs);
  }

  /** Open the websocket. On any close we schedule a reconnect with
   *  exponential backoff up to 60s. */
  private connectWebsocket(): void {
    if (this.stopped) {
      return;
    }
    const url = this.client.devicesWebsocketUrl;
    const ws = new WebSocket(url, {
      headers: {
        'X-API-KEY': this.client.apiKeyHeader,
        'User-Agent': 'homebridge-unifi-sensors',
      },
      rejectUnauthorized: this.client.rejectUnauthorizedTls,
      handshakeTimeout: 10_000,
    });

    this.ws = ws;

    ws.on('open', () => {
      this.wsReconnectAttempts = 0;
      this.log.debug(`Devices websocket connected: ${url}`);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.handleWsMessage(data);
    });

    ws.on('error', (err: Error) => {
      this.log.debug(`Devices websocket error: ${err.message}`);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.log.debug(`Devices websocket closed (${code}) ${reason?.toString?.() ?? ''}`);
      this.ws = undefined;
      if (this.stopped) {
        return;
      }
      const delay = Math.min(60_000, 5_000 * Math.pow(2, this.wsReconnectAttempts));
      this.wsReconnectAttempts++;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (!this.stopped) {
          this.connectWebsocket();
        }
      }, delay);
    });
  }

  /** Parse a single websocket frame and emit one update per payload
   *  found. We split sensors from fobs based on `modelKey` and route to
   *  the appropriate event channel. */
  private handleWsMessage(data: WebSocket.RawData): void {
    const text = wsDataToUtf8(data);
    if (!text || (text[0] !== '{' && text[0] !== '[')) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const { sensors, fobs } = this.extractDevicePayloads(parsed);
    sensors.forEach((sensor) => this.emit('update', { sensor, source: 'websocket' }));
    fobs.forEach((fob) => this.emit('fobUpdate', { fob, source: 'websocket' }));
  }

  /**
   * Walk an arbitrary JSON payload and split out sensor and fob
   * payloads. Handles all the envelope shapes the Integration API uses
   * (single-device add/update/remove, bulk variants, raw arrays) with
   * one recursive descent rather than parsing per-shape.
   *
   * The key discriminator is `modelKey`: "sensor" goes to the sensors
   * bucket, "fob" goes to the fobs bucket. Other modelKeys (camera,
   * chime, light, ...) are silently dropped: this plugin doesn't expose
   * them and we don't want to clutter the log on every tick.
   */
  private extractDevicePayloads(parsed: unknown): { sensors: SensorPartial[]; fobs: FobPartial[] } {
    const out = { sensors: [] as SensorPartial[], fobs: [] as FobPartial[] };

    const walk = (node: unknown): void => {
      if (!node) {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== 'object') {
        return;
      }
      const obj = node as Record<string, unknown>;
      if (typeof obj.id === 'string') {
        if (obj.modelKey === 'sensor') {
          out.sensors.push(obj as SensorPartial);
          return;
        }
        if (obj.modelKey === 'fob') {
          out.fobs.push(obj as FobPartial);
          return;
        }
      }
      // Recurse into known envelope containers. We bound the work per
      // message by only walking specific field names rather than the
      // whole tree.
      if (obj.item) walk(obj.item);
      if (Array.isArray(obj.items)) obj.items.forEach(walk);
      if (Array.isArray(obj.data)) obj.data.forEach(walk);
      if (Array.isArray(obj.sensors)) obj.sensors.forEach(walk);
      if (Array.isArray(obj.fobs)) obj.fobs.forEach(walk);
    };

    walk(parsed);
    return out;
  }
}
