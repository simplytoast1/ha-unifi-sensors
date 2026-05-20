// UnifiSensorAccessory: maps a single UniFi Protect sensor onto a single
// HomeKit accessory.
//
// Design notes
// ============
//
// 1. ONE accessory per UniFi sensor, MANY services on that accessory.
//    The UP-Sense is a combo device. A single physical sensor can be
//    simultaneously a motion detector, a temperature sensor, a humidity
//    sensor, an ambient light sensor, a leak probe, a smoke/CO listener,
//    and (when mounted on a door / window / garage) a contact sensor.
//    We expose every enabled capability as a discrete HomeKit service on
//    the same accessory, keyed by service subtype. HomeKit handles this
//    natively (Eve, Home, Controller all render it correctly).
//
// 2. Services are added and removed idempotently on every refresh.
//    The set of services on an accessory tracks the live UniFi config:
//    if the user disables motion in the Protect UI, refreshMotion() finds
//    `motionSettings.isEnabled === false` and removes the MotionSensor
//    service. Same for the Homebridge config `hide*` toggles. No restart
//    of Homebridge is required for capability changes to take effect.
//
// 3. Leak <-> Contact swap.
//    When a sensor is in leak mount mode, the user can choose in the
//    Homebridge UI to surface it as either a LeakSensor or a ContactSensor
//    via `exposeLeakAsContact`. The swap happens by removing one service
//    and adding the other under the same subtype slot.
//
// 4. Name sync is one-way and only on creation.
//    Accessory creation pulls the name from UniFi. After that we never
//    overwrite the displayName or the per-service Name characteristic on
//    refresh, so a user rename in Home.app sticks. The per-sensor config
//    `name` field is the explicit escape hatch for users who want a
//    name that survives all renames.
//
// 5. Battery + accessory identity live on every accessory always.
//    Even if all sensor capabilities are disabled, we still expose
//    Battery (so HomeKit shows the icon and low-battery alerts) and
//    AccessoryInformation (so Home.app shows serial / firmware / model).

import type {
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';
import type { UnifiSensorsPlatform } from './platform';
import { ALARM_TRIGGER_HOLD_MS, MIN_LUX, MOTION_TRIGGER_HOLD_MS } from './settings';
import type { BatteryStatus, PerSensorConfig, ProtectSensor } from './unifi/types';

/** Subtype tag used on each service so multiple instances of the same
 *  HomeKit type (e.g. two ContactSensors, one for "contact" and one for
 *  "alarm") can coexist on a single accessory. */
type Subtype =
  | 'motion'
  | 'contact'
  | 'leak'
  | 'temperature'
  | 'humidity'
  | 'light'
  | 'alarm';

export class UnifiSensorAccessory {
  private readonly platform: UnifiSensorsPlatform;
  private readonly accessory: PlatformAccessory;
  /** Latest known sensor state. Updated by merging partial diffs from the
   *  websocket on top of snapshot data from REST polls. */
  private current: ProtectSensor;
  private config: PerSensorConfig;
  /** Reported as HomeKit FirmwareRevision. The Integration API doesn't
   *  carry per-sensor firmware, so the platform passes the NVR-level
   *  Protect application version instead. */
  private firmwareRevision: string;

  /** Tracks which "shape" the leak slot currently has (LeakSensor vs
   *  ContactSensor) so we can detect a toggle of exposeLeakAsContact and
   *  swap services in one place. */
  private leakIsContact = false;

  /** Previous values of the boolean states we log on transition. We log
   *  on edge, not level, so a noisy snapshot loop doesn't fill the
   *  Homebridge log with redundant entries. `undefined` means "we
   *  haven't seen a value yet" so the first observation is silent --
   *  startup baseline should not generate a flurry of "motion
   *  detected" entries on every restart. */
  private lastMotion?: boolean;
  private lastOpened?: boolean;
  private lastLeak?: boolean;
  private lastAlarm?: boolean;

  constructor(
    platform: UnifiSensorsPlatform,
    accessory: PlatformAccessory,
    initial: ProtectSensor,
    config: PerSensorConfig,
    firmwareRevision: string,
  ) {
    this.platform = platform;
    this.accessory = accessory;
    this.current = initial;
    this.config = config;
    this.firmwareRevision = firmwareRevision;
    this.refreshAll();
  }

  /** Stable identifier used by the platform to look this handler up by MAC. */
  get mac(): string {
    return this.current.mac;
  }

  /** Called when the user edits config.json. We re-run the full service
   *  reconciliation so newly-hidden capabilities disappear and newly-shown
   *  ones reappear without a Homebridge restart. */
  setConfig(config: PerSensorConfig): void {
    this.config = config;
    this.refreshAll();
  }

  /** Called when the platform's cached Protect version changes (e.g. after
   *  a NVR firmware update reflected at startup). */
  setFirmwareRevision(version: string): void {
    this.firmwareRevision = version;
    this.refreshAccessoryInformation();
  }

  /** Merge a partial or full sensor payload into our current state and
   *  re-evaluate every service. Partial updates come from the websocket;
   *  full ones from REST polls. */
  update(patch: Partial<ProtectSensor>): void {
    this.current = { ...this.current, ...patch } as ProtectSensor;
    this.refreshAll();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private get hap() {
    return this.platform.api.hap;
  }

  /** Recompute every service. Each refresh* call is responsible for
   *  add/update/remove of its own service so this stays a thin dispatcher. */
  private refreshAll(): void {
    this.refreshAccessoryInformation();
    this.refreshBattery();
    this.refreshMotion();
    this.refreshContact();
    this.refreshLeak();
    this.refreshTemperature();
    this.refreshHumidity();
    this.refreshLight();
    this.refreshAlarm();
  }

  /** HomeKit "StatusActive" semantics: true when the sensor is online.
   *  UniFi's state machine is CONNECTED / CONNECTING / DISCONNECTED, and
   *  only CONNECTED counts as actively reporting. */
  private isConnected(): boolean {
    return this.current.state === 'CONNECTED';
  }

  /** Read the modern wirelessConnectionState.batteryStatus and fall back
   *  to the legacy top-level batteryStatus (still emitted on some firmware
   *  even though the spec marks it deprecated). */
  private batteryStatus(): BatteryStatus | undefined {
    return this.current.wirelessConnectionState?.batteryStatus
      ?? this.current.batteryStatus;
  }

  /** The name we'd choose for this accessory if we were creating it from
   *  scratch right now. config.name wins over the UniFi name; if both are
   *  missing we fall back to a MAC-derived label so the accessory is at
   *  least addressable. */
  private displayName(): string {
    return this.config.name || this.current.name || `UniFi Sensor ${this.current.mac}`;
  }

  /** Manufacturer / Model / Serial / Firmware shown in Home.app's
   *  accessory detail screen. Refreshed on every update so a firmware
   *  bump, a config.name override, or a sensor changing roles in Protect
   *  propagates immediately. */
  private refreshAccessoryInformation(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const info = this.accessory.getService(Service.AccessoryInformation)
      ?? this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Ubiquiti')
      .setCharacteristic(Characteristic.Model, this.detectModel())
      // MAC is the only stable per-device identifier the API exposes.
      .setCharacteristic(Characteristic.SerialNumber, this.current.mac)
      .setCharacteristic(Characteristic.FirmwareRevision, this.firmwareRevision);

    // Name on AccessoryInformation is set only when the user has an
    // explicit config override. We avoid clobbering the user's HomeKit
    // rename otherwise -- see "Name sync" note at the top of this file.
    if (this.config.name) {
      info.setCharacteristic(Characteristic.Name, this.config.name);
    }
  }

  /**
   * Guess the product name from the live capability set.
   *
   * The Integration API only tells us `modelKey: "sensor"` -- it does NOT
   * carry a `model`, `type`, or `marketName` field, even though the UniFi
   * UI obviously knows the difference between a UP Sense and a UP Smoke.
   * The UI gets this from the legacy /proxy/protect/api bootstrap data,
   * which the Integration API deliberately omits.
   *
   * The least-bad heuristic from public fields:
   *   - UP Smoke: alarm enabled, every other capability disabled.
   *   - UP Sense: anything else (it's the combination sensor and is by
   *     far the most common UniFi Protect sensor).
   *   - Fallback to a generic label when the capability set is empty so
   *     we don't lie about hardware we can't identify.
   */
  public detectModel(): string {
    const hasAlarm = !!this.current.alarmSettings?.isEnabled;
    const hasMotion = !!this.current.motionSettings?.isEnabled;
    const hasTemp = !!this.current.temperatureSettings?.isEnabled;
    const hasHumidity = !!this.current.humiditySettings?.isEnabled;
    const hasLight = !!this.current.lightSettings?.isEnabled;
    const hasLeak =
      this.current.mountType === 'leak'
      || !!this.current.leakSettings?.isInternalEnabled
      || !!this.current.leakSettings?.isExternalEnabled;
    const hasContact = ['door', 'window', 'garage'].includes(this.current.mountType ?? '');

    const senseCaps = hasMotion || hasTemp || hasHumidity || hasLight || hasLeak || hasContact;

    if (hasAlarm && !senseCaps) {
      return 'UP Smoke';
    }
    if (senseCaps) {
      return 'UP Sense';
    }
    return 'UniFi Sensor';
  }

  /** Human-readable summary of enabled capabilities, used in the
   *  discovery log so the operator can confirm at a glance that the
   *  plugin sees the same picture as the UniFi UI. */
  public capabilitySummary(): string {
    const caps: string[] = [];
    if (this.current.motionSettings?.isEnabled) caps.push('motion');
    if (this.current.temperatureSettings?.isEnabled) caps.push('temperature');
    if (this.current.humiditySettings?.isEnabled) caps.push('humidity');
    if (this.current.lightSettings?.isEnabled) caps.push('light');
    if (
      this.current.mountType === 'leak'
      || this.current.leakSettings?.isInternalEnabled
      || this.current.leakSettings?.isExternalEnabled
    ) {
      caps.push('leak');
    }
    if (['door', 'window', 'garage'].includes(this.current.mountType ?? '')) {
      caps.push(`contact:${this.current.mountType}`);
    }
    if (this.current.alarmSettings?.isEnabled) caps.push('alarm');
    return caps.length ? caps.join(', ') : 'none';
  }

  /** Battery service is always present so HomeKit can display the icon
   *  and trigger low-battery notifications, regardless of which sensor
   *  capabilities are enabled. */
  private refreshBattery(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const service = this.accessory.getService(Service.Battery)
      ?? this.accessory.addService(Service.Battery, this.displayName() + ' Battery');
    const battery = this.batteryStatus();
    const percentage = typeof battery?.percentage === 'number' ? battery.percentage : 0;
    // Clamp defensively: HomeKit rejects values outside 0-100.
    service.updateCharacteristic(Characteristic.BatteryLevel, Math.max(0, Math.min(100, percentage)));
    service.updateCharacteristic(
      Characteristic.StatusLowBattery,
      battery?.isLow
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    // UP-Sense runs on a CR123A; never reports charging.
    service.updateCharacteristic(
      Characteristic.ChargingState,
      Characteristic.ChargingState.NOT_CHARGEABLE,
    );
  }

  /** MotionSensor service. Visible when Protect has motion detection
   *  enabled for this sensor AND the user hasn't hidden it in config. */
  private refreshMotion(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const enabled = this.current.motionSettings?.isEnabled && !this.config.hideMotion;
    const service = this.ensureService(Service.MotionSensor, 'motion', `${this.displayName()} Motion`, enabled);
    if (!service) {
      return;
    }
    const detected = this.isMotionDetected();
    service.updateCharacteristic(Characteristic.MotionDetected, detected);
    this.logTransition('motion', this.lastMotion, detected, (v) => v ? 'detected' : 'cleared');
    this.lastMotion = detected;
    this.applyStatusCommon(service);
  }

  /** Motion is "detected" if either:
   *   - the live flag is true (current snapshot), or
   *   - motionDetectedAt is within the hold window
   *  The hold window papers over the case where we see a timestamp diff
   *  but no corresponding `isMotionDetected: true` payload. */
  private isMotionDetected(): boolean {
    if (this.current.isMotionDetected) {
      return true;
    }
    const at = this.current.motionDetectedAt ?? 0;
    if (!at) {
      return false;
    }
    return Date.now() - at < MOTION_TRIGGER_HOLD_MS;
  }

  /** ContactSensor service for mount-based contact detection.
   *  Only present when the sensor is physically mounted as door / window /
   *  garage; leak-mounted sensors use the LeakSensor service path. */
  private refreshContact(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const mount = this.current.mountType;
    const isContactMount = mount === 'door' || mount === 'window' || mount === 'garage';
    const enabled = isContactMount && !this.config.hideContact;
    const service = this.ensureService(
      Service.ContactSensor,
      'contact',
      `${this.displayName()} Contact`,
      enabled,
    );
    if (!service) {
      return;
    }
    // HomeKit semantics: CONTACT_DETECTED means the magnets are together
    // (i.e. door closed). isOpened=true from UniFi means the opposite.
    const open = this.current.isOpened === true;
    service.updateCharacteristic(
      Characteristic.ContactSensorState,
      open
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    this.logTransition('contact', this.lastOpened, open, (v) => v ? 'opened' : 'closed');
    this.lastOpened = open;
    this.applyStatusCommon(service);
  }

  /**
   * LeakSensor (or ContactSensor when exposeLeakAsContact is on).
   *
   * The slot is "leak" but the service type depends on user config. We
   * track which shape we currently have in `leakIsContact` so a toggle of
   * the config flag triggers a clean swap (remove old service, add new
   * one) rather than two services on the same subtype.
   */
  private refreshLeak(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    // Leak is "available" when either the mount is set to leak OR the user
    // has explicitly turned on internal / external leak detection in
    // Protect. The two leakSettings flags drive the physical probes; the
    // mountType says how the sensor is installed.
    const leakEnabledInUnifi =
      this.current.mountType === 'leak'
      || this.current.leakSettings?.isInternalEnabled
      || this.current.leakSettings?.isExternalEnabled;
    const enabled = !!leakEnabledInUnifi && !this.config.hideLeak;

    const asContact = !!this.config.exposeLeakAsContact;

    // If the user just toggled exposeLeakAsContact, drop the existing
    // service before adding the replacement so HomeKit sees a clean swap
    // rather than two services with the same subtype.
    if (this.leakIsContact !== asContact) {
      this.removeService(Service.LeakSensor, 'leak');
      this.removeService(Service.ContactSensor, 'leak');
      this.leakIsContact = asContact;
    }

    if (asContact) {
      const service = this.ensureService(
        Service.ContactSensor,
        'leak',
        `${this.displayName()} Leak`,
        enabled,
      );
      if (!service) {
        return;
      }
      const wet = this.isLeakDetected();
      // ContactSensor convention: NOT_DETECTED means "circuit broken" which
      // we map to "leak detected" (probe sees water -> contact "opens").
      service.updateCharacteristic(
        Characteristic.ContactSensorState,
        wet
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
      this.logTransition('leak', this.lastLeak, wet, (v) => v ? 'WET' : 'dry');
      this.lastLeak = wet;
      this.applyStatusCommon(service);
    } else {
      const service = this.ensureService(
        Service.LeakSensor,
        'leak',
        `${this.displayName()} Leak`,
        enabled,
      );
      if (!service) {
        return;
      }
      const wet = this.isLeakDetected();
      service.updateCharacteristic(
        Characteristic.LeakDetected,
        wet
          ? Characteristic.LeakDetected.LEAK_DETECTED
          : Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      );
      this.logTransition('leak', this.lastLeak, wet, (v) => v ? 'WET' : 'dry');
      this.lastLeak = wet;
      this.applyStatusCommon(service);
    }
  }

  /** A leak is "active" if either probe (internal or external) reported
   *  one within the last 60s. We use the more recent of the two timestamps
   *  so the alert clears once both probes have been dry for a minute. */
  private isLeakDetected(): boolean {
    const internal = this.current.leakDetectedAt ?? 0;
    const external = this.current.externalLeakDetectedAt ?? 0;
    const at = Math.max(internal, external);
    if (!at) {
      return false;
    }
    return Date.now() - at < 60_000;
  }

  /** Temperature reading in degrees Celsius. The UP-Sense is rated
   *  -39 to +124°C; we clamp to ±100 just to keep HomeKit happy on a
   *  glitchy reading. */
  private refreshTemperature(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const enabled = this.current.temperatureSettings?.isEnabled && !this.config.hideTemperature;
    const service = this.ensureService(
      Service.TemperatureSensor,
      'temperature',
      `${this.displayName()} Temperature`,
      enabled,
    );
    if (!service) {
      return;
    }
    const value = this.current.stats?.temperature?.value;
    if (typeof value === 'number') {
      service.updateCharacteristic(
        Characteristic.CurrentTemperature,
        Math.max(-100, Math.min(100, value)),
      );
    }
    this.applyStatusCommon(service);
  }

  /** Relative humidity 0-100%. */
  private refreshHumidity(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const enabled = this.current.humiditySettings?.isEnabled && !this.config.hideHumidity;
    const service = this.ensureService(
      Service.HumiditySensor,
      'humidity',
      `${this.displayName()} Humidity`,
      enabled,
    );
    if (!service) {
      return;
    }
    const value = this.current.stats?.humidity?.value;
    if (typeof value === 'number') {
      service.updateCharacteristic(
        Characteristic.CurrentRelativeHumidity,
        Math.max(0, Math.min(100, value)),
      );
    }
    this.applyStatusCommon(service);
  }

  /** Ambient light in lux. HomeKit requires >= 0.0001; UniFi sometimes
   *  reports 0 in pitch dark rooms. */
  private refreshLight(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const enabled = this.current.lightSettings?.isEnabled && !this.config.hideLight;
    const service = this.ensureService(
      Service.LightSensor,
      'light',
      `${this.displayName()} Light`,
      enabled,
    );
    if (!service) {
      return;
    }
    const value = this.current.stats?.light?.value;
    if (typeof value === 'number') {
      service.updateCharacteristic(
        Characteristic.CurrentAmbientLightLevel,
        Math.max(MIN_LUX, value),
      );
    }
    this.applyStatusCommon(service);
  }

  /** Smoke / CO alarm listener exposed as a ContactSensor. ContactSensor is
   *  the cleanest HomeKit primitive for "fires when an event happens, no
   *  hold semantics required" -- the alternative SmokeSensor service in
   *  HomeKit is for true smoke detectors and triggers Apple's emergency
   *  flow, which would be misleading here (UP-Sense listens for an
   *  external alarm's sound rather than detecting smoke itself). */
  private refreshAlarm(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const enabled = this.current.alarmSettings?.isEnabled && !this.config.hideAlarm;
    const service = this.ensureService(
      Service.ContactSensor,
      'alarm',
      `${this.displayName()} Alarm`,
      enabled,
    );
    if (!service) {
      return;
    }
    const at = this.current.alarmTriggeredAt ?? 0;
    const active = at > 0 && Date.now() - at < ALARM_TRIGGER_HOLD_MS;
    service.updateCharacteristic(
      Characteristic.ContactSensorState,
      active
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    this.logTransition('alarm', this.lastAlarm, active, (v) => v ? 'TRIGGERED' : 'cleared');
    this.lastAlarm = active;
    this.applyStatusCommon(service);
  }

  /** Log a state transition at info level so users can see device
   *  activity in the Homebridge log without enabling debug. The first
   *  observation (prev === undefined) is intentionally silent to avoid
   *  a flurry of "motion cleared" entries on every plugin start. */
  private logTransition<T>(label: string, prev: T | undefined, curr: T, format: (v: T) => string): void {
    if (!this.platform.logEventsEnabled) {
      return;
    }
    if (prev === undefined || prev === curr) {
      return;
    }
    this.platform.log.info(`[${this.displayName()}] ${label}: ${format(curr)}`);
  }

  /** Attach the three optional status characteristics every sensor service
   *  should carry. We have to addOptionalCharacteristic on first use
   *  because hap-nodejs won't accept updateCharacteristic on an absent
   *  optional characteristic. */
  private applyStatusCommon(service: Service): void {
    const Characteristic = this.hap.Characteristic;

    if (!service.testCharacteristic(Characteristic.StatusActive)) {
      service.addOptionalCharacteristic(Characteristic.StatusActive);
    }
    service.updateCharacteristic(Characteristic.StatusActive, this.isConnected());

    if (!service.testCharacteristic(Characteristic.StatusTampered)) {
      service.addOptionalCharacteristic(Characteristic.StatusTampered);
    }
    const tampered = !!this.current.tamperingDetectedAt;
    service.updateCharacteristic(
      Characteristic.StatusTampered,
      tampered
        ? Characteristic.StatusTampered.TAMPERED
        : Characteristic.StatusTampered.NOT_TAMPERED,
    );

    if (!service.testCharacteristic(Characteristic.StatusLowBattery)) {
      service.addOptionalCharacteristic(Characteristic.StatusLowBattery);
    }
    service.updateCharacteristic(
      Characteristic.StatusLowBattery,
      this.batteryStatus()?.isLow
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  }

  /**
   * Service lifecycle helper. Given a service type and a subtype slot:
   *   - if `enabled` is true and the service is missing, add it
   *     (using `name` as the initial Service.Name -- never updated again
   *      after creation, to honour the one-way name sync rule)
   *   - if `enabled` is true and the service exists, return it as-is so
   *     the caller can update its data characteristics
   *   - if `enabled` is false, remove the service if present and return
   *     undefined (caller short-circuits)
   */
  private ensureService(
    serviceType: WithUUID<typeof Service>,
    subtype: Subtype,
    name: string,
    enabled: boolean | undefined,
  ): Service | undefined {
    const existing = this.accessory.getServiceById(serviceType, subtype);
    if (!enabled) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    if (existing) {
      // Intentionally NOT updating the Name characteristic here. The name
      // we set at creation persists for the lifetime of the accessory;
      // user renames in Home.app are respected.
      return existing;
    }
    return this.accessory.addService(serviceType, name, subtype);
  }

  /** Tear down a service if it exists. Safe to call when absent. */
  private removeService(serviceType: WithUUID<typeof Service>, subtype: Subtype): void {
    const existing = this.accessory.getServiceById(serviceType, subtype);
    if (existing) {
      this.accessory.removeService(existing);
    }
  }
}
