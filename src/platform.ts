// UnifiSensorsPlatform: Homebridge dynamic platform that owns the lifecycle
// of every accessory backed by a UniFi Protect sensor.
//
// Lifecycle overview
// ==================
//
//   Homebridge boot
//        |
//        v
//   constructor() ----- read config, register handlers
//        |
//        v
//   configureAccessory()  (called once per cached accessory)
//        |
//        v
//   didFinishLaunching event
//        |
//        v
//   startup() ----- ping /v1/meta/info, build event stream
//        |
//        v
//   stream 'snapshot' event ----- reconcileSnapshot()
//        |                              |
//        |                              +-- registerPlatformAccessories for new
//        |                              +-- update accessories for existing
//        |                              +-- unregisterPlatformAccessories for missing
//        |
//        v
//   stream 'update' event ----- handleUpdate()
//        |                              |
//        |                              +-- look up by mac (or id when mac is omitted)
//        |                              +-- merge partial into the handler
//        |
//        v
//   shutdown event ----- stream.stop()
//
// Identity, naming, and deletion
// ==============================
//
// - **Identity** is by `mac`. We compute `uuid = generate(mac)` and use that
//   for both the HomeKit accessory UUID and the local handler map key.
//   `idToMac` is a secondary index so partial websocket updates that carry
//   only an `id` can still find the right handler.
//
// - **Name sync** is one-way (UniFi -> HomeKit) and only at first
//   discovery. After the accessory exists we never overwrite its
//   displayName or any service Name characteristic, so renames the user
//   makes in Home.app stick. The per-sensor `config.name` field is the
//   explicit override for users who want a name that survives all
//   renames.
//
// - **Deletion** happens in three cases:
//     (a) a sensor disappears from /v1/sensors -- unregistered in
//         reconcileSnapshot()
//     (b) a sensor is marked `hide: true` in config -- unregistered in
//         reconcileSnapshot() before we'd otherwise upsert it
//     (c) a cached accessory restored at startup has no matching MAC in
//         the live snapshot -- same path as (a)
//   In all three cases we also drop the entry from `accessories`,
//   `handlers`, and `idToMac` so we don't hold a stale reference.

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { UnifiFobAccessory } from './fobAccessory';
import { UnifiSensorAccessory } from './platformAccessory';
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_REMOVE_AFTER_MISSING_SNAPSHOTS,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings';
import { IntegrationApiClient, IntegrationApiError } from './unifi/client';
import { SensorEventStream } from './unifi/events';
import type { FobPartial, SensorPartial } from './unifi/events';
import { EventStream } from './unifi/event-stream';
import type { ButtonPress } from './unifi/event-stream';
import type { PerFobConfig, PerSensorConfig, ProtectFob, ProtectSensor } from './unifi/types';

/** Shape of the Homebridge platform block in config.json. Mirrors the
 *  config.schema.json file, with all properties optional so we can degrade
 *  gracefully (e.g. log a clear error and skip startup) when required
 *  fields are missing. */
interface UnifiSensorsPlatformConfig extends PlatformConfig {
  host?: string;
  apiKey?: string;
  rejectUnauthorized?: boolean;
  pollIntervalSeconds?: number;
  preferWebsocket?: boolean;
  removeAfterMissingSnapshots?: number;
  logEvents?: boolean;
  sensors?: PerSensorConfig[];
  fobs?: PerFobConfig[];
}

export class UnifiSensorsPlatform implements DynamicPlatformPlugin {
  // Exposed to UnifiSensorAccessory via `platform.Service` / `.Characteristic`.
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** All accessories currently registered with Homebridge, keyed by UUID.
   *  Populated by `configureAccessory` for cached accessories restored at
   *  startup and by `upsertSensor` when we register a new one. */
  public readonly accessories = new Map<string, PlatformAccessory>();

  /** UnifiSensorAccessory handlers, keyed by normalised MAC. One per
   *  active accessory; dropped on hide / deletion. */
  private readonly handlers = new Map<string, UnifiSensorAccessory>();

  /** UnifiFobAccessory handlers, keyed by normalised MAC. Mirrors the
   *  sensor handler map so the discovery / deletion code paths are
   *  symmetric. */
  private readonly fobHandlers = new Map<string, UnifiFobAccessory>();

  /** Sensor `id` -> normalised MAC. Websocket partial updates may carry
   *  only an `id`, so we keep this side index to route them back to the
   *  correct handler without re-listing sensors on every diff. */
  private readonly idToMac = new Map<string, string>();

  /** Fob `id` -> normalised MAC. Same purpose as idToMac for sensors. */
  private readonly fobIdToMac = new Map<string, string>();

  /** Per-sensor config from the platform block, keyed by normalised MAC.
   *  Built at construction time and refreshed if the user reloads
   *  Homebridge. */
  private readonly perSensor = new Map<string, PerSensorConfig>();

  /** Per-fob config block, same shape as perSensor. */
  private readonly perFob = new Map<string, PerFobConfig>();

  /** Sensor ids that have shown up in websocket diffs but were not
   *  present in the last snapshot. Prevents an infinite refetch storm
   *  when the bridge reports updates for sensors that are paired but
   *  not enumerated (observed live: two phantom sensor ids that the
   *  bridge tracks but /v1/sensors does not return). */
  private readonly unknownSensorIds = new Set<string>();
  /** Same idea for fobs, kept separate for cleanliness even though
   *  phantom fob ids haven't been observed in practice. */
  private readonly unknownFobIds = new Set<string>();

  /** Consecutive-missing-snapshot counts keyed by normalised MAC. Used
   *  to defer accessory removal in `sweepMissing` so a transient API
   *  hiccup or a device rebooting doesn't wipe HomeKit state. Reset on
   *  every successful upsert; incremented on every snapshot that does
   *  not surface the device. */
  private readonly sensorMissCounts = new Map<string, number>();
  private readonly fobMissCounts = new Map<string, number>();

  private client?: IntegrationApiClient;
  private stream?: SensorEventStream;
  /** Subscriber for the event-log channel (button presses). Independent
   *  of `stream`, which carries device-state diffs. */
  private eventStream?: EventStream;

  /** Whether per-accessory state-transition logging is on. Read by the
   *  accessory handlers via `platform.logEventsEnabled` so config
   *  changes take effect at the next refresh. Defaults to true. */
  public get logEventsEnabled(): boolean {
    return this.typedConfig.logEvents !== false;
  }
  private readonly typedConfig: UnifiSensorsPlatformConfig;
  /** Protect application version reported by /v1/meta/info, surfaced as
   *  the FirmwareRevision on every accessory. The Integration API does
   *  not expose per-sensor firmware, so this NVR-level value is the
   *  closest available stand-in. */
  private protectVersion = '0.0.0';

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.typedConfig = config as UnifiSensorsPlatformConfig;

    // Index the per-sensor config blocks so lookup during snapshot
    // reconciliation is O(1). Normalisation strips colons / dashes so
    // users can paste a MAC in any common format.
    for (const entry of this.typedConfig.sensors ?? []) {
      if (entry?.mac) {
        this.perSensor.set(this.normalizeMac(entry.mac), entry);
      }
    }
    for (const entry of this.typedConfig.fobs ?? []) {
      if (entry?.mac) {
        this.perFob.set(this.normalizeMac(entry.mac), entry);
      }
    }

    // Wait for Homebridge to finish loading cached accessories before we
    // hit the API. didFinishLaunching is the only safe spot for I/O.
    this.api.on('didFinishLaunching', () => {
      void this.startup();
    });

    // Tear both websockets down cleanly on Homebridge stop so the
    // process exits promptly.
    this.api.on('shutdown', () => {
      this.stream?.stop();
      this.eventStream?.stop();
    });
  }

  /**
   * Called once per cached accessory at startup, BEFORE didFinishLaunching.
   * We hold onto every cached accessory we see -- snapshot reconciliation
   * later decides which ones to keep, refresh, or unregister.
   *
   * Cached accessories that lack `mac` in their context are unrecognisable
   * (we can't match them to a live sensor) so we unregister them right
   * away to avoid leaking phantom accessories.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    const mac = accessory.context?.mac as string | undefined;
    if (!mac) {
      this.log.warn(
        `Cached accessory "${accessory.displayName}" has no mac in context; unregistering.`,
      );
      // We can't safely call unregisterPlatformAccessories until
      // didFinishLaunching, so just don't track it -- Homebridge handles
      // the eventual cleanup on the next persist when it sees the
      // accessory isn't in our active set.
      return;
    }
    this.accessories.set(accessory.UUID, accessory);
  }

  /** Validate config, build the API client + event stream, and start the
   *  reconcile loop. Failures here are terminal for this platform but do
   *  not crash Homebridge -- we log loudly and bail. */
  private async startup(): Promise<void> {
    if (!this.typedConfig.host || !this.typedConfig.apiKey) {
      this.log.error(
        'Missing required config: "host" and "apiKey". Update Homebridge config and reload.',
      );
      return;
    }

    this.client = new IntegrationApiClient({
      host: this.typedConfig.host,
      apiKey: this.typedConfig.apiKey,
      rejectUnauthorized: this.typedConfig.rejectUnauthorized ?? false,
    });

    // Ping /meta/info first so we (a) confirm the API key is good before
    // we start spinning the event stream and (b) capture the application
    // version for FirmwareRevision. If this fails the user almost
    // certainly has a misconfigured host or a bad key; log clearly and
    // skip the rest of startup.
    try {
      const meta = await this.client.getMetaInfo();
      this.protectVersion = meta.applicationVersion || '0.0.0';
      this.log.info(
        `Connected to UniFi Protect at ${this.typedConfig.host} (application version ${this.protectVersion}).`,
      );
    } catch (err) {
      const e = err as IntegrationApiError;
      if (e.status === 401 || e.status === 403) {
        this.log.error(
          `UniFi rejected the API key (HTTP ${e.status}). Check the Integration API key and try again.`,
        );
      } else {
        this.log.error(
          `Could not reach UniFi Protect at ${this.typedConfig.host}: ${e.message}`,
        );
      }
      return;
    }

    this.stream = new SensorEventStream({
      client: this.client,
      log: this.log,
      pollIntervalSeconds: this.typedConfig.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
      preferWebsocket: this.typedConfig.preferWebsocket ?? true,
    });

    this.stream.on('snapshot', (sensors) => this.reconcileSensorSnapshot(sensors));
    this.stream.on('update', ({ sensor }) => this.handleSensorUpdate(sensor));
    this.stream.on('fobSnapshot', (fobs) => this.reconcileFobSnapshot(fobs));
    this.stream.on('fobUpdate', ({ fob }) => this.handleFobUpdate(fob));
    this.stream.on('error', (err) => this.log.debug(`Stream error: ${err.message}`));

    await this.stream.start();

    // Separate websocket for the event-log channel. Used exclusively to
    // route fob button presses onto the matching HomeKit programmable
    // switch service. If the connection never comes up, fob accessories
    // still exist; they just don't fire any presses.
    this.eventStream = new EventStream({
      client: this.client,
      log: this.log,
    });
    this.eventStream.on('button', (press) => this.handleButtonPress(press));
    this.eventStream.on('error', (err) => this.log.debug(`Event stream error: ${err.message}`));
    this.eventStream.start();
  }

  /**
   * Apply a fresh snapshot of all sensors. This is the authoritative
   * sync point for the sensor side: it adds new accessories, refreshes
   * existing ones, and unregisters anything that's no longer in the
   * snapshot or is now hidden by config.
   *
   * The deletion sweep is split into a separate helper that the fob
   * snapshot reconciler reuses with its own `seen` set, so the two
   * device types share a single deletion strategy.
   */
  private reconcileSensorSnapshot(sensors: ProtectSensor[]): void {
    const seen = new Set<string>();
    for (const sensor of sensors) {
      if (!sensor.mac) {
        // The spec requires mac, so this is genuinely surprising. Skip
        // the entry rather than crash; the user will see something is
        // wrong from the missing accessory.
        continue;
      }
      const mac = this.normalizeMac(sensor.mac);
      seen.add(mac);
      const cfg = this.perSensor.get(mac) ?? { mac };
      if (cfg.hide) {
        // User-hidden sensors are torn down on every snapshot so toggling
        // hide on in the UI propagates without a Homebridge restart.
        this.removeSensorByMac(mac);
        continue;
      }
      this.upsertSensor(sensor, cfg);
    }
    this.sweepMissing('sensor', seen);
  }

  /** Same idea for fobs. */
  private reconcileFobSnapshot(fobs: ProtectFob[]): void {
    const seen = new Set<string>();
    for (const fob of fobs) {
      if (!fob.mac) {
        continue;
      }
      const mac = this.normalizeMac(fob.mac);
      seen.add(mac);
      const cfg = this.perFob.get(mac) ?? { mac };
      if (cfg.hide) {
        this.removeFobByMac(mac);
        continue;
      }
      this.upsertFob(fob, cfg);
    }
    this.sweepMissing('fob', seen);
  }

  /**
   * Unregister any accessories of the given kind that weren't seen in
   * this snapshot. Kind is determined by the accessory.context.kind
   * field set on creation (default 'sensor' for back-compat with
   * accessories cached before fob support was added).
   *
   * Removal is deferred until a device has been missing for
   * `removeAfterMissingSnapshots` consecutive snapshots. The default
   * is 0, which means "never auto-remove" -- accessories survive
   * indefinitely until the user explicitly hides them in config. Set
   * to a positive integer in the Homebridge UI to opt into automatic
   * cleanup after the configured number of consecutive misses.
   * Devices that reappear in a later snapshot reset their miss count
   * via the upsert path below.
   */
  private sweepMissing(kind: 'sensor' | 'fob', seen: Set<string>): void {
    const threshold = Math.max(0, this.typedConfig.removeAfterMissingSnapshots
      ?? DEFAULT_REMOVE_AFTER_MISSING_SNAPSHOTS);
    const missCounts = kind === 'sensor' ? this.sensorMissCounts : this.fobMissCounts;

    for (const [uuid, accessory] of this.accessories) {
      const accessoryKind = (accessory.context?.kind as string | undefined) ?? 'sensor';
      if (accessoryKind !== kind) {
        continue;
      }
      const mac = (accessory.context?.mac as string | undefined);
      if (!mac) {
        // Defensive: drop unkeyed accessories so we don't carry them
        // forward indefinitely. Unkeyed entries are leftover from a
        // bug, not real devices, so the grace period doesn't apply.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
        continue;
      }
      const normalized = this.normalizeMac(mac);
      if (seen.has(normalized)) {
        // Device is present this round; clear any pending miss count.
        // (upsert also clears it, but be defensive in case ordering
        // changes in the future.)
        missCounts.delete(normalized);
        continue;
      }

      // Device was absent this round. Bump the miss counter.
      const misses = (missCounts.get(normalized) ?? 0) + 1;
      missCounts.set(normalized, misses);

      // Threshold of 0 disables auto-removal entirely. Otherwise we
      // wait until the count meets the threshold, then unregister.
      if (threshold === 0 || misses < threshold) {
        if (misses === 1) {
          this.log.debug(
            `${kind} accessory ${accessory.displayName} (${mac}) absent from snapshot ` +
            `(miss 1${threshold ? ` of ${threshold}` : ', auto-remove disabled'})`,
          );
        }
        continue;
      }

      this.log.info(
        `Removing ${kind} accessory no longer present in UniFi: ${accessory.displayName} ` +
        `(${mac}) after ${misses} consecutive missing snapshots`,
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      missCounts.delete(normalized);
      const id = accessory.context?.id as string | undefined;
      if (kind === 'sensor') {
        this.handlers.delete(normalized);
        if (id) this.idToMac.delete(id);
      } else {
        this.fobHandlers.delete(normalized);
        if (id) this.fobIdToMac.delete(id);
      }
    }
  }

  /**
   * Create or update the accessory + handler for a single sensor. Two
   * important behaviours to know about:
   *
   *   - Name sync is one-way and only happens on accessory creation. We
   *     read the UniFi name (or the config override) into displayName at
   *     create time and never overwrite it afterwards. Users who rename
   *     in Home.app keep their rename; users who want a name lock can
   *     set `config.name` (always wins on every refresh).
   *
   *   - The handler is created lazily on first sight of a sensor. On
   *     subsequent calls we just feed it the latest state.
   */
  private upsertSensor(sensor: ProtectSensor, cfg: PerSensorConfig): void {
    const mac = this.normalizeMac(sensor.mac);
    const uuid = this.api.hap.uuid.generate(mac);
    // Resolve the initial display name. Order: config override > UniFi
    // name > MAC-derived fallback. The result is only used when creating
    // a new accessory; we never overwrite the displayName of an existing
    // one (see the "Name sync" note in the file header).
    const initialName = cfg.name || sensor.name || `UniFi Sensor ${mac}`;

    const isNew = !this.accessories.has(uuid);
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      // First time seeing this sensor: create the accessory.
      accessory = new this.api.platformAccessory(initialName, uuid);
      // Persist the sensor id + mac in the accessory context so we can
      // match it back on next launch (configureAccessory only gets the
      // cached accessory itself, not a parallel index). `kind`
      // disambiguates sensor accessories from fob accessories during
      // the snapshot deletion sweep.
      accessory.context.mac = mac;
      accessory.context.id = sensor.id;
      accessory.context.kind = 'sensor';
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    } else {
      // Existing accessory: refresh the context only (id may have changed
      // if the sensor was re-added to UniFi, mac is the same by
      // construction). Deliberately NOT touching displayName here.
      accessory.context.mac = mac;
      accessory.context.id = sensor.id;
      accessory.context.kind = 'sensor';
    }

    this.idToMac.set(sensor.id, mac);
    // If the bridge previously reported a diff for this id before we
    // had it in the snapshot, drop the phantom marker now.
    this.unknownSensorIds.delete(sensor.id);
    // Device is alive again (or has been all along); clear any
    // accrued missing-snapshot count so the sweep doesn't penalise it
    // for past absences.
    this.sensorMissCounts.delete(mac);

    let handler = this.handlers.get(mac);
    if (!handler) {
      handler = new UnifiSensorAccessory(this, accessory, sensor, cfg, this.protectVersion);
      this.handlers.set(mac, handler);
    } else {
      // Push config and version updates through the handler so it can
      // tear down / rebuild services as needed.
      handler.setConfig(cfg);
      handler.setFirmwareRevision(this.protectVersion);
      handler.update(sensor);
    }

    // Log discovery AFTER the handler exists so we can ask it for the
    // detected model and capability list. Only log on the first sight of
    // a sensor to keep restart logs quiet.
    if (isNew) {
      this.log.info(
        `Discovered "${initialName}": model=${handler.detectModel()}, mac=${mac}, ` +
        `state=${sensor.state ?? '?'}, mountType=${sensor.mountType ?? 'none'}, ` +
        `capabilities=[${handler.capabilitySummary()}]. ` +
        `Add this mac to the Sensors list in Homebridge config to hide it or change leak<->contact.`,
      );
    }
  }

  /**
   * Route a websocket diff to the right handler. Two lookup paths:
   *   1. If the diff carries `mac` (which `deviceAdd` always does), use it
   *      directly.
   *   2. If the diff carries only `id` (the common case for `deviceUpdate`,
   *      where the spec sends sensorPartialWithReference), look up via the
   *      id -> mac index we populate in upsertSensor.
   *
   * If neither resolves to a known handler we trigger a full snapshot
   * refetch rather than try to invent state -- usually means a sensor was
   * added since the last snapshot.
   */
  private handleSensorUpdate(sensor: SensorPartial): void {
    const mac = sensor.mac ? this.normalizeMac(sensor.mac) : this.idToMac.get(sensor.id);
    if (!mac) {
      // Unknown id: trigger ONE refetch per id. If the next snapshot
      // still doesn't surface this sensor, mark it phantom and stop
      // refetching for it -- prevents the storm we observed where the
      // bridge emits updates for sensor ids /v1/sensors never returns.
      if (this.unknownSensorIds.has(sensor.id)) {
        return;
      }
      this.unknownSensorIds.add(sensor.id);
      void this.refetchSensorSnapshot();
      return;
    }
    const cfg = this.perSensor.get(mac) ?? { mac };
    if (cfg.hide) {
      return;
    }
    const handler = this.handlers.get(mac);
    if (!handler) {
      // Same logic: avoid refetch storms.
      if (this.unknownSensorIds.has(sensor.id)) {
        return;
      }
      this.unknownSensorIds.add(sensor.id);
      void this.refetchSensorSnapshot();
      return;
    }
    handler.update(sensor);
  }

  /** Mirror of handleSensorUpdate for fob diffs. */
  private handleFobUpdate(fob: FobPartial): void {
    const mac = fob.mac ? this.normalizeMac(fob.mac) : this.fobIdToMac.get(fob.id);
    if (!mac) {
      if (this.unknownFobIds.has(fob.id)) {
        return;
      }
      this.unknownFobIds.add(fob.id);
      void this.refetchFobSnapshot();
      return;
    }
    const cfg = this.perFob.get(mac) ?? { mac };
    if (cfg.hide) {
      return;
    }
    const handler = this.fobHandlers.get(mac);
    if (!handler) {
      if (this.unknownFobIds.has(fob.id)) {
        return;
      }
      this.unknownFobIds.add(fob.id);
      void this.refetchFobSnapshot();
      return;
    }
    handler.update(fob);
  }

  /**
   * Create or update the accessory + handler for a single fob. Same
   * one-way name sync rules as upsertSensor.
   */
  private upsertFob(fob: ProtectFob, cfg: PerFobConfig): void {
    const mac = this.normalizeMac(fob.mac);
    const uuid = this.api.hap.uuid.generate(`fob:${mac}`);
    const initialName = cfg.name || fob.name || `UniFi Fob ${mac}`;

    const isNew = !this.accessories.has(uuid);
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(initialName, uuid);
      accessory.context.mac = mac;
      accessory.context.id = fob.id;
      accessory.context.kind = 'fob';
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    } else {
      accessory.context.mac = mac;
      accessory.context.id = fob.id;
      accessory.context.kind = 'fob';
    }

    this.fobIdToMac.set(fob.id, mac);
    this.unknownFobIds.delete(fob.id);
    this.fobMissCounts.delete(mac);

    let handler = this.fobHandlers.get(mac);
    if (!handler) {
      handler = new UnifiFobAccessory(this, accessory, fob, cfg, this.protectVersion);
      this.fobHandlers.set(mac, handler);
    } else {
      handler.setConfig(cfg);
      handler.setFirmwareRevision(this.protectVersion);
      handler.update(fob);
    }

    if (isNew) {
      this.log.info(
        `Discovered fob "${initialName}": mac=${mac}, id=${fob.id}, state=${fob.state ?? '?'}, ` +
        `awayState=${fob.awayState}, buttons=[${(fob.featureFlags?.buttons ?? []).join(', ')}]. ` +
        `Add this mac to the Fobs list in Homebridge config to hide it or trim buttons.`,
      );
    }
  }

  /**
   * Route a button-press event onto a fob handler.
   *
   * The event's `device` field is supposed to identify the source, but
   * across firmware versions it may be either the fob's id or the paired
   * alarm hub's id. We try the fob lookup first; on a miss we log loudly
   * (with all the info needed to debug, including the full button name)
   * and fan out to every visible fob that advertises that button. The
   * fan-out is intentionally conservative -- on most installs there's
   * one fob anyway, and a stray press is better than a silent miss
   * while we work out the routing on real hardware.
   */
  private handleButtonPress(press: ButtonPress): void {
    const direct = this.fobIdToMac.get(press.deviceId);
    if (direct) {
      const handler = this.fobHandlers.get(direct);
      if (handler) {
        this.log.debug(
          `Button ${press.button} pressed on fob ${direct} (source=${press.source})`,
        );
        handler.pressButton(press.button);
        return;
      }
    }
    // Fallback: no direct match. Likely the event carries the alarm
    // hub's id rather than the fob's. Fan out to every fob that
    // advertises this button.
    const candidates = [...this.fobHandlers.values()];
    if (candidates.length === 0) {
      this.log.debug(
        `Ignoring button press (button=${press.button}, deviceId=${press.deviceId}, ` +
        `source=${press.source}): no fobs registered.`,
      );
      return;
    }
    this.log.info(
      `Button ${press.button} pressed (deviceId=${press.deviceId} not a known fob; ` +
      `source=${press.source}). Fanning out to all fobs that advertise this button.`,
    );
    for (const handler of candidates) {
      handler.pressButton(press.button);
    }
  }

  /** Force a full sensor snapshot pull. Used when a websocket diff
   *  references a sensor we don't know about yet. */
  private async refetchSensorSnapshot(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      const sensors = await this.client.listSensors();
      this.reconcileSensorSnapshot(sensors);
    } catch (err) {
      this.log.debug(`Failed to refetch sensor snapshot: ${(err as Error).message}`);
    }
  }

  /** Same idea for fobs. */
  private async refetchFobSnapshot(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      const fobs = await this.client.listFobs();
      this.reconcileFobSnapshot(fobs);
    } catch (err) {
      this.log.debug(`Failed to refetch fob snapshot: ${(err as Error).message}`);
    }
  }

  /** Tear down a sensor accessory tied to a MAC. */
  private removeSensorByMac(mac: string): void {
    const uuid = this.api.hap.uuid.generate(mac);
    const accessory = this.accessories.get(uuid);
    if (accessory) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.handlers.delete(mac);
      const id = accessory.context?.id as string | undefined;
      if (id) {
        this.idToMac.delete(id);
      }
      this.log.info(`Hidden by config: removed sensor ${accessory.displayName} (${mac}).`);
    }
  }

  /** Tear down a fob accessory tied to a MAC. */
  private removeFobByMac(mac: string): void {
    const uuid = this.api.hap.uuid.generate(`fob:${mac}`);
    const accessory = this.accessories.get(uuid);
    if (accessory) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.fobHandlers.delete(mac);
      const id = accessory.context?.id as string | undefined;
      if (id) {
        this.fobIdToMac.delete(id);
      }
      this.log.info(`Hidden by config: removed fob ${accessory.displayName} (${mac}).`);
    }
  }

  /** Strip everything that isn't a hex digit and lowercase the result. We
   *  use the normalised form as the lookup key everywhere so users can
   *  paste MACs with any common separator (colon, hyphen, none). */
  private normalizeMac(mac: string): string {
    return mac.toLowerCase().replace(/[^a-f0-9]/g, '');
  }
}
