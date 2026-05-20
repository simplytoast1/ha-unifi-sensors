// Event-log subscriber for UniFi Protect /v1/subscribe/events.
//
// This is a SEPARATE channel from /v1/subscribe/devices that powers
// SensorEventStream:
//
//   - /v1/subscribe/devices  : add/update/remove diffs of device-state
//                              (sensor settings, battery, mountType, etc.)
//   - /v1/subscribe/events   : discrete events on the timeline
//                              (button press, motion start, leak, ...)
//
// We need the events channel for fob button presses, which the device
// channel does not carry. Other event types pass through here too but
// we only re-emit button ones; everything else we already pick up via
// device-state diffs.
//
// Press semantics
// ===============
//
// Earlier versions of this plugin tried to derive single / double /
// long press from event timing. Real-world testing with the UniFi USL
// Fob on Protect 7.1.60 showed that:
//
//   - Every button event arrives with start === end, so there is no
//     press-duration signal to derive a long press from.
//   - The firmware debounces same-button events to a minimum gap of
//     ~1 second, so no reasonable double-press window can catch
//     "two taps in quick succession" without also catching two
//     intentional separate presses.
//
// We therefore emit exactly one ButtonPress per Integration-API
// button event, period. HomeKit always sees SINGLE_PRESS. The
// StatelessProgrammableSwitch service on the fob accessory restricts
// its ProgrammableSwitchEvent validValues to SINGLE_PRESS so the Home
// app does not offer DOUBLE / LONG triggers that would never fire.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from 'homebridge';
import { IntegrationApiClient } from './client';
import type { ButtonPressEvent, FobButton } from './types';
import { wsDataToUtf8 } from './ws-decode';

/** A button-press event, surfaced upward to the platform for routing
 *  onto the matching HomeKit StatelessProgrammableSwitch. */
export interface ButtonPress {
  /** Device id that fired the event. Verified against the live console
   *  to be the fob's id (not the alarm hub's) on Protect 7.1.60. */
  deviceId: string;
  button: FobButton;
  source: ButtonPressEvent['type'];
}

export interface EventStreamOptions {
  client: IntegrationApiClient;
  log: Logger;
}

type EventStreamEvents = {
  button: [ButtonPress];
  error: [Error];
};

/**
 * Connects to /v1/subscribe/events and emits a 'button' event for
 * every button-press payload it sees. Stateless: each Integration-API
 * event maps 1:1 to one outgoing emission. Reconnect logic mirrors
 * SensorEventStream: exponential backoff capped at 60s.
 */
export class EventStream extends EventEmitter<EventStreamEvents> {
  private readonly client: IntegrationApiClient;
  private readonly log: Logger;

  private ws?: WebSocket;
  /** Pending reconnect, if any. Stored on the instance so stop() can
   *  cancel it; otherwise the Node event loop is kept alive for up to
   *  60s after Homebridge shutdown waiting for a reconnect that will
   *  immediately be no-op'd by `stopped`. */
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private wsReconnectAttempts = 0;

  constructor(opts: EventStreamOptions) {
    super();
    this.client = opts.client;
    this.log = opts.log;
  }

  /** Open the websocket and start listening. */
  start(): void {
    this.connectWebsocket();
  }

  /** Idempotent shutdown. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already gone
      }
      this.ws = undefined;
    }
  }

  private connectWebsocket(): void {
    if (this.stopped) {
      return;
    }
    const url = this.client.eventsWebsocketUrl;
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
      this.log.debug(`Event websocket connected: ${url}`);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.handleWsMessage(data);
    });

    ws.on('error', (err: Error) => {
      this.log.debug(`Event websocket error: ${err.message}`);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.log.debug(`Event websocket closed (${code}) ${reason?.toString?.() ?? ''}`);
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
    this.extractButtonEvents(parsed).forEach((event) => {
      this.emit('button', {
        deviceId: event.device,
        button: event.metadata.button.text,
        source: event.type,
      });
    });
  }

  /** Walk an arbitrary JSON payload and pull out every button-press
   *  event inside. Same recursive-descent strategy as the device
   *  stream's extractor. */
  private extractButtonEvents(parsed: unknown): ButtonPressEvent[] {
    const out: ButtonPressEvent[] = [];

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
      if (this.isButtonPressEvent(obj)) {
        out.push(obj as unknown as ButtonPressEvent);
        return;
      }
      if (obj.item) walk(obj.item);
      if (Array.isArray(obj.items)) obj.items.forEach(walk);
    };

    walk(parsed);
    return out;
  }

  /** Type guard for the button-press shape, kept tight so we don't try
   *  to dispatch on motion / leak / etc. events that also flow on this
   *  channel. */
  private isButtonPressEvent(obj: Record<string, unknown>): boolean {
    if (obj.modelKey !== 'event') {
      return false;
    }
    const type = obj.type;
    if (type !== 'alarmHubButtonPress' && type !== 'sensorButtonPressed') {
      return false;
    }
    const md = obj.metadata as Record<string, unknown> | undefined;
    return !!md && !!(md.button as Record<string, unknown> | undefined)?.text;
  }
}
