// UnifiFobAccessory: maps one UniFi Protect fob onto a HomeKit accessory.
//
// HomeKit pattern
// ===============
//
// Each physical fob becomes ONE PlatformAccessory with:
//
//   - AccessoryInformation : Manufacturer / Model / Serial (mac) / Firmware
//   - Battery              : level + low-battery flag
//   - StatelessProgrammableSwitch (one per advertised button)
//
// StatelessProgrammableSwitch is Apple's standard pattern for physical
// buttons that should trigger HomeKit automations (Eve Light Switch,
// Aqara cube, etc.). Each service has a ServiceLabelIndex so HomeKit's
// "Allow Automation" picker lists them in a stable order, plus a
// ProgrammableSwitchEvent characteristic that we pulse SINGLE_PRESS on
// when the matching button fires upstream.
//
// Press semantics
// ===============
//
// The Integration API only delivers SINGLE press events for fob
// buttons -- there is no press-duration signal and the firmware
// debounces same-button events to ~1 second, so there is no reliable
// way to derive DOUBLE_PRESS or LONG_PRESS. Each button's
// ProgrammableSwitchEvent characteristic restricts its validValues to
// SINGLE_PRESS so the Home app does not offer triggers that would
// never fire.
//
// Identity & naming
// =================
//
// Same conventions as the sensor accessory:
//   - mac is the stable identifier (HomeKit UUID is generate(mac))
//   - the per-fob `config.name` override always wins on every refresh
//   - otherwise displayName is set once at creation and never touched
//     again, so a user rename in Home.app sticks.

import type {
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';
import type { UnifiSensorsPlatform } from './platform';
import { DEFAULT_FOB_BUTTONS } from './settings';
import type { BatteryStatus, FobButton, PerFobConfig, ProtectFob } from './unifi/types';

export class UnifiFobAccessory {
  private readonly platform: UnifiSensorsPlatform;
  private readonly accessory: PlatformAccessory;
  private current: ProtectFob;
  private config: PerFobConfig;
  private firmwareRevision: string;

  /** Maps each visible button to its HomeKit ProgrammableSwitchEvent
   *  characteristic so a press can be delivered with a single
   *  characteristic update without re-discovering the service every
   *  time. Built in refreshButtons(). */
  private buttonChars = new Map<FobButton, ReturnType<Service['getCharacteristic']>>();

  constructor(
    platform: UnifiSensorsPlatform,
    accessory: PlatformAccessory,
    initial: ProtectFob,
    config: PerFobConfig,
    firmwareRevision: string,
  ) {
    this.platform = platform;
    this.accessory = accessory;
    this.current = initial;
    this.config = config;
    this.firmwareRevision = firmwareRevision;
    this.refreshAll();
  }

  get mac(): string {
    return this.current.mac;
  }

  /** Stable id used by the platform's button-event router to map
   *  incoming events to this fob. */
  get id(): string {
    return this.current.id;
  }

  setConfig(config: PerFobConfig): void {
    this.config = config;
    this.refreshAll();
  }

  setFirmwareRevision(version: string): void {
    this.firmwareRevision = version;
    this.refreshAccessoryInformation();
  }

  /** Merge a partial or full fob payload into our current state and
   *  re-evaluate every service. */
  update(patch: Partial<ProtectFob>): void {
    this.current = { ...this.current, ...patch } as ProtectFob;
    this.refreshAll();
  }

  /** Called by the platform when a matching button event arrives. Fires
   *  SINGLE_PRESS on the corresponding HomeKit characteristic. Silently
   *  no-ops if the fob doesn't advertise that button or the user has
   *  hidden it, so a stray event never crashes the plugin. */
  pressButton(button: FobButton): void {
    const ch = this.buttonChars.get(button);
    if (!ch) {
      if (this.platform.logEventsEnabled) {
        this.platform.log.info(
          `[${this.displayName()}] button ${button} pressed but no HomeKit switch exists ` +
          `for it. Enable this button via the plugin UI to surface it.`,
        );
      }
      return;
    }
    const Characteristic = this.platform.api.hap.Characteristic;
    if (this.platform.logEventsEnabled) {
      this.platform.log.info(`[${this.displayName()}] button ${button} pressed`);
    }
    // HomeKit semantics: setValue (not updateValue) is required for
    // StatelessProgrammableSwitch events; updateValue is for stateful
    // reads, while setValue actually notifies subscribers and triggers
    // automations.
    ch.setValue(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private get hap() {
    return this.platform.api.hap;
  }

  private refreshAll(): void {
    this.refreshAccessoryInformation();
    this.refreshBattery();
    this.refreshButtons();
  }

  private batteryStatus(): BatteryStatus | undefined {
    return this.current.wirelessConnectionState?.batteryStatus;
  }

  private displayName(): string {
    return this.config.name || this.current.name || `UniFi Fob ${this.current.mac}`;
  }

  private refreshAccessoryInformation(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const info = this.accessory.getService(Service.AccessoryInformation)
      ?? this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Ubiquiti')
      .setCharacteristic(Characteristic.Model, 'UniFi Fob')
      .setCharacteristic(Characteristic.SerialNumber, this.current.mac)
      .setCharacteristic(Characteristic.FirmwareRevision, this.firmwareRevision);
    if (this.config.name) {
      info.setCharacteristic(Characteristic.Name, this.config.name);
    }
  }

  /** Battery service, always present. Same approach as the sensor side. */
  private refreshBattery(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const service = this.accessory.getService(Service.Battery)
      ?? this.accessory.addService(Service.Battery, this.displayName() + ' Battery');
    const battery = this.batteryStatus();
    const percentage = typeof battery?.percentage === 'number' ? battery.percentage : 0;
    service.updateCharacteristic(Characteristic.BatteryLevel, Math.max(0, Math.min(100, percentage)));
    service.updateCharacteristic(
      Characteristic.StatusLowBattery,
      battery?.isLow
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    service.updateCharacteristic(
      Characteristic.ChargingState,
      Characteristic.ChargingState.NOT_CHARGEABLE,
    );
  }

  /**
   * Resolve which buttons to expose. Priority:
   *   1. Per-fob `config.buttons` override -- always wins. Set this when
   *      you know your fob's button layout and the API is wrong.
   *   2. API-advertised buttons (featureFlags.buttons) when present and
   *      non-empty.
   *   3. DEFAULT_FOB_BUTTONS (function/arm/disarm/panic) -- the typical
   *      four-button alarm fob layout, used when the API reports
   *      featureFlags: {} as it does for at least the USL Fob on Protect
   *      7.1.60.
   * Then subtract anything in `config.hideButtons`.
   */
  private resolveButtons(): FobButton[] {
    const apiButtons = this.current.featureFlags?.buttons ?? [];
    let base: FobButton[];
    if (this.config.buttons && this.config.buttons.length > 0) {
      base = this.config.buttons;
    } else if (apiButtons.length > 0) {
      base = apiButtons;
    } else {
      base = DEFAULT_FOB_BUTTONS;
    }
    const hidden = new Set<FobButton>(this.config.hideButtons ?? []);
    return base.filter((b) => !hidden.has(b));
  }

  /** Reconcile StatelessProgrammableSwitch services against the fob's
   *  resolved button set. Idempotent: missing services are added,
   *  surplus ones are removed, and the buttonChars map is rebuilt to
   *  match. */
  private refreshButtons(): void {
    const Service = this.hap.Service;
    const Characteristic = this.hap.Characteristic;
    const visible = this.resolveButtons();

    // Remove services for buttons that are no longer visible. We iterate
    // the existing services on the accessory rather than the prior
    // buttonChars map so a config change that hides everything cleans up
    // properly.
    const visibleSubtypes = new Set<string>(visible.map((b) => `button-${b}`));
    const existingServices = this.accessory.services
      .filter((svc) => svc.UUID === Service.StatelessProgrammableSwitch.UUID);
    for (const svc of existingServices) {
      if (!svc.subtype || !visibleSubtypes.has(svc.subtype)) {
        this.accessory.removeService(svc);
      }
    }

    // Rebuild the buttonChars map from scratch each refresh. It's small
    // and rebuilding is cheaper than tracking deltas.
    this.buttonChars.clear();
    visible.forEach((button, index) => {
      const subtype = `button-${button}`;
      const name = `${this.displayName()} ${this.buttonLabel(button)}`;
      const service = this.accessory.getServiceById(Service.StatelessProgrammableSwitch, subtype)
        ?? this.accessory.addService(
          Service.StatelessProgrammableSwitch as WithUUID<typeof Service>,
          name,
          subtype,
        );

      // ServiceLabelIndex orders buttons consistently in the Home app's
      // "Allow Automation" picker. We use the button's position in the
      // featureFlags.buttons array as the index so it's stable across
      // restarts (the API returns the same order every call on a given
      // firmware version).
      service.setCharacteristic(Characteristic.ServiceLabelIndex, index + 1);

      // Some Home app versions also read ConfiguredName from the service,
      // so we set it once at creation. testCharacteristic guards against
      // adding the optional characteristic twice.
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
        service.addOptionalCharacteristic(Characteristic.ConfiguredName);
      }
      // Only set the configured name on initial creation: same one-way
      // sync rule we use for sensors. We detect "initial creation" by
      // looking for an empty current value.
      if (!service.getCharacteristic(Characteristic.ConfiguredName).value) {
        service.setCharacteristic(Characteristic.ConfiguredName, name);
      }

      // StatusActive mirrors the fob's online state -- a fob marked
      // DEVICE_LOST shows as inactive so the user knows automations
      // won't fire.
      if (!service.testCharacteristic(Characteristic.StatusActive)) {
        service.addOptionalCharacteristic(Characteristic.StatusActive);
      }
      service.updateCharacteristic(Characteristic.StatusActive, this.isActive());

      // Restrict the ProgrammableSwitchEvent characteristic to only
      // SINGLE_PRESS. The Home app reads validValues to populate the
      // automation trigger picker, so this hides DOUBLE_PRESS and
      // LONG_PRESS options that we cannot fire on this hardware.
      const evChar = service.getCharacteristic(Characteristic.ProgrammableSwitchEvent);
      evChar.setProps({ validValues: [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS] });
      this.buttonChars.set(button, evChar);
    });
  }

  /** True when the fob is considered live. We treat anything other than
   *  DEVICE_LOST as active to avoid pessimistic flapping on RECENTLY_SEEN
   *  / NO_RECENT_HEARTBEAT. */
  private isActive(): boolean {
    if (this.current.state !== 'CONNECTED') {
      return false;
    }
    return this.current.awayState !== 'DEVICE_LOST';
  }

  /** Pretty label for the button name used in service Name +
   *  ConfiguredName. The Integration API uses bare enum strings like
   *  "arm" / "disarm" which look unfinished in Home.app on their own. */
  private buttonLabel(button: FobButton): string {
    switch (button) {
      case 'function': return 'Function';
      case 'alarmHubButton': return 'Hub Button';
      case 'arm': return 'Arm';
      case 'disarm': return 'Disarm';
      case 'night': return 'Night';
      case 'panic': return 'Panic';
      case 'left': return 'Left';
      case 'right': return 'Right';
      case 'input1': return 'Input 1';
      case 'input2': return 'Input 2';
      default: return button;
    }
  }
}
