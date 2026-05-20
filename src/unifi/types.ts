// TypeScript types mirroring the UniFi Protect Integration API v1.
//
// Source of truth: https://apidoc-cdn.ui.com/protect/v7.1.46/integration.json
// (the OpenAPI 3.1 spec Ubiquiti publishes alongside their official Ansible
// module). Field names, optionality, and enum values match the spec exactly
// so changes upstream stay easy to track.
//
// Important: the Integration API schema is intentionally smaller than the
// legacy /proxy/protect/api bootstrap schema used by older plugins. It does
// NOT include firmwareVersion, marketName, type, hardwareRevision, isConnected,
// bridge, or camera at the sensor level. Anything you'd expect to find there
// has to come from /v1/meta/info (NVR-level) or be derived (e.g. connectivity
// from `state === 'CONNECTED'`).

/** Helper alias matching the OpenAPI spec's nullable convention. */
export type Nullable<T> = T | null;

/** Response from GET /v1/meta/info. Only field documented is the version. */
export interface ProtectMetaInfo {
  /** Protect application version (e.g. "7.1.46"). Used as HomeKit
   *  FirmwareRevision on every accessory because the Integration API does
   *  not expose per-sensor firmware. */
  applicationVersion: string;
}

/** Connection state. CONNECTED is the only "healthy" value; HomeKit's
 *  StatusActive characteristic reflects this. */
export type DeviceState = 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED';

/** Physical mounting mode set in the Protect UI. Drives which HomeKit
 *  service a UP-Sense surfaces as: door/window/garage -> ContactSensor,
 *  leak -> LeakSensor (or ContactSensor when exposeLeakAsContact is on),
 *  none -> ambient-only (motion/temp/humidity/light/alarm). */
export type SensorMountType = 'door' | 'window' | 'garage' | 'leak' | 'none';

export interface BatteryStatus {
  /** 0-100, null when the sensor hasn't reported yet. */
  percentage: Nullable<number>;
  /** True when Protect's own low-battery threshold fires. */
  isLow: boolean;
}

export interface SignalState {
  signalQuality: number;
  signalStrength: number;
}

/** Modern home for battery info on the Integration API. The top-level
 *  ProtectSensor.batteryStatus field still exists but is flagged DEPRECATED
 *  in the spec; new fields land here. We always prefer this path. */
export interface WirelessConnectionState {
  signalState: SignalState;
  batteryStatus: BatteryStatus;
  /** ID of the AP / bridge this sensor pairs through. Null when direct. */
  bridge: Nullable<string>;
}

/** Shape shared by light/humidity/temperature settings on a UP-Sense. The
 *  isEnabled flag is what we read; the thresholds are configured in
 *  Protect and we ignore them in HomeKit (HomeKit just surfaces the raw
 *  reading; users build their own automations on top). */
export interface ThresholdSettings {
  isEnabled: boolean;
  margin?: number;
  lowThreshold?: Nullable<number>;
  highThreshold?: Nullable<number>;
}

export interface MotionSettings {
  isEnabled: boolean;
  sensitivity?: number;
}

export interface LeakSettings {
  /** Built-in leak probe at the base of the sensor. */
  isInternalEnabled: boolean;
  /** Optional external probe (the cable that hangs from the sensor). */
  isExternalEnabled: boolean;
}

export interface AlarmSettings {
  /** Smoke + CO alarm listener (audio detection). */
  isEnabled: boolean;
}

/** One readout from the ambient sensors. */
export interface SensorMetric {
  value: Nullable<number>;
  status?: string;
}

/** Live readings exposed under sensor.stats. The UP-Sense is a true
 *  combo device: a single physical sensor can populate all three at once. */
export interface SensorStats {
  light?: SensorMetric;      // lux
  humidity?: SensorMetric;   // %RH
  temperature?: SensorMetric; // °C
}

/**
 * Full sensor object returned by GET /v1/sensors and GET /v1/sensors/{id}.
 *
 * A single UP-Sense reports state for all of its capabilities in one object.
 * The plugin maps this 1:1 to a HomeKit accessory and turns the per-feature
 * `*Settings.isEnabled` flags into separate HomeKit services (motion,
 * contact, leak, temperature, humidity, light, alarm) layered on top.
 */
export interface ProtectSensor {
  // Identity
  id: string;
  modelKey: 'sensor';
  state: DeviceState;
  name: Nullable<string>;
  mac: string;
  mountType: SensorMountType;

  // Battery (prefer wirelessConnectionState.batteryStatus over the deprecated top-level field)
  batteryStatus?: BatteryStatus;
  wirelessConnectionState?: WirelessConnectionState;

  // Live ambient readings
  stats?: SensorStats;

  // Per-capability settings
  lightSettings?: ThresholdSettings;
  humiditySettings?: ThresholdSettings;
  temperatureSettings?: ThresholdSettings;
  motionSettings?: MotionSettings;
  alarmSettings?: AlarmSettings;
  leakSettings?: LeakSettings;

  // Stateful event fields. Each `*At` is a unix-millis timestamp the
  // sensor stamps when the event last fired; null/0 means never.
  isOpened: Nullable<boolean>;
  openStatusChangedAt: Nullable<number>;
  isMotionDetected: boolean;
  motionDetectedAt: Nullable<number>;
  alarmTriggeredAt: Nullable<number>;
  leakDetectedAt: Nullable<number>;
  externalLeakDetectedAt: Nullable<number>;
  tamperingDetectedAt: Nullable<number>;
}

// ---------------------------------------------------------------------------
// Fob
// ---------------------------------------------------------------------------
//
// UniFi Protect fobs are wireless key fobs paired to the alarm system.
// Each physical fob model has its own button layout, reported in
// featureFlags.buttons.

/** Every button the fob hardware supports (per the OpenAPI enum). One
 *  HomeKit StatelessProgrammableSwitch service per entry the fob actually
 *  has. */
export type FobButton =
  | 'function'
  | 'alarmHubButton'
  | 'arm'
  | 'disarm'
  | 'night'
  | 'panic'
  | 'left'
  | 'right'
  | 'input1'
  | 'input2';

/** Presence state. Not currently mapped to HomeKit (could become an
 *  OccupancySensor in a future revision); we surface it as StatusActive
 *  on the button services so a "lost" fob shows as inactive. */
export type FobAwayState = 'ONLINE' | 'RECENTLY_SEEN' | 'NO_RECENT_HEARTBEAT' | 'DEVICE_LOST';

/** Per the OpenAPI spec this should be `{ buttons: FobButton[] }` but the
 *  live API on Protect 7.1.60 returns `{}` for at least the USL Fob.
 *  Everything is optional here so we can degrade cleanly when fields
 *  aren't present. */
export interface FobFeatureFlags {
  buttons?: FobButton[];
}

/** Full fob object returned by GET /v1/fobs and GET /v1/fobs/{id}. Note
 *  the surface is small -- fobs don't carry stats, settings, or other
 *  per-feature toggles. Button presses arrive on /v1/subscribe/events
 *  rather than as fields on this object.
 *
 *  featureFlags is optional because the live API returns it as an empty
 *  object on at least one firmware/model combo. When the buttons array
 *  is missing or empty the plugin falls back to a configured or default
 *  button list. */
export interface ProtectFob {
  id: string;
  modelKey: 'fob';
  state: DeviceState;
  name: Nullable<string>;
  mac: string;
  awayState: FobAwayState;
  featureFlags?: FobFeatureFlags;
  wirelessConnectionState?: WirelessConnectionState;
}

/** Per-fob config block from the Homebridge config UI. Same hide pattern
 *  as sensors so the verified-plugin per-device-hide bar is met for fobs
 *  too. */
export interface PerFobConfig {
  mac: string;
  name?: string;
  hide?: boolean;
  /** Explicit list of buttons this fob exposes. Used to override the
   *  Integration API's featureFlags.buttons when that field is missing
   *  or empty (the live API returns `featureFlags: {}` for some fob
   *  models, even though the OpenAPI spec marks buttons as required).
   *  If set, this wins over both the API list and the default fallback. */
  buttons?: FobButton[];
  /** Subset of buttons to hide. Useful when you want to keep most of
   *  the auto-discovered buttons but drop a few. */
  hideButtons?: FobButton[];
}

// ---------------------------------------------------------------------------
// Event stream payloads
// ---------------------------------------------------------------------------

/** Envelope shape for WS /v1/subscribe/devices messages. The websocket
 *  delivers diffs, not full snapshots: `item` is typically a partial sensor
 *  (id + modelKey + just the changed fields), so consumers must merge into
 *  an existing state object rather than assume every field is present. */
export type DeviceEventType = 'add' | 'update' | 'remove';

export interface DeviceEvent {
  type: DeviceEventType;
  item: Partial<ProtectSensor> & { id: string; modelKey?: string };
}

/** Event payload as it arrives on /v1/subscribe/events. The events
 *  channel is distinct from the device-state channel: it broadcasts
 *  discrete events (button press, motion start, leak detected, ...)
 *  rather than full-object diffs. We only care about the button-press
 *  shape; everything else we already cover via the device channel.
 *
 *  Both alarmHubButtonPressEvent and sensorButtonPressedEvent carry
 *  metadata.button.text using the same enum as FobButton. The `device`
 *  field is a deviceId pointing at whichever device fired the event --
 *  in our case ideally the fob, but the spec leaves that ambiguous so we
 *  route by id and log loudly if the lookup misses. */
export interface ButtonPressEvent {
  id: string;
  modelKey: 'event';
  type: 'alarmHubButtonPress' | 'sensorButtonPressed';
  start: number;
  end: Nullable<number>;
  device: string;
  metadata: {
    button: { text: FobButton };
  };
}

/** One entry in the `sensors` array of the platform config block. Used to
 *  hide a sensor entirely, hide individual capabilities, or pin a display
 *  name. The `mac` is the join key; everything else is opt-in. */
export interface PerSensorConfig {
  mac: string;
  /** Optional name override. When set this beats the UniFi name on every
   *  refresh, giving the user a way to lock in a name that survives the
   *  one-way UniFi -> HomeKit sync. */
  name?: string;
  hide?: boolean;
  hideMotion?: boolean;
  hideContact?: boolean;
  hideLeak?: boolean;
  hideTemperature?: boolean;
  hideHumidity?: boolean;
  hideLight?: boolean;
  hideAlarm?: boolean;
  /** When true and the sensor is mounted as a leak probe, expose it in
   *  HomeKit as a ContactSensor instead of a LeakSensor. Some HomeKit
   *  automations and third-party UIs treat ContactSensor as more useful
   *  than LeakSensor; this gives users the choice. */
  exposeLeakAsContact?: boolean;
}
