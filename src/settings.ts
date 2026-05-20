// Plugin-wide constants. Keep this file dependency-free so any module can import
// from it without dragging the rest of the plugin in.

// The pluginAlias from config.schema.json. Homebridge uses this string to
// look up plugin handlers when loading config.json blocks.
export const PLATFORM_NAME = 'UnifiSensors';

// The npm package name. Used in registerPlatformAccessories /
// unregisterPlatformAccessories calls so cached accessory files land under
// the right plugin namespace on disk.
export const PLUGIN_NAME = 'homebridge-unifi-sensors';

// Polling cadence when the websocket subscribe stream is unavailable. Five
// seconds matches what feels "instant" in the Home app while keeping load
// on the console low even with dozens of sensors.
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

// How long a single alarm trigger pulses on the HomeKit ContactSensor that
// fronts the alarm. The Integration API gives us a timestamp
// (alarmTriggeredAt) but no "ended" event, so we pretend the alarm is
// active for this long after the timestamp and then auto-clear.
export const ALARM_TRIGGER_HOLD_MS = 5_000;

// Same reasoning for motion. The sensor sometimes reports a stale
// motionDetectedAt without isMotionDetected being true; we treat motion as
// active for this window after the timestamp.
export const MOTION_TRIGGER_HOLD_MS = 5_000;

// HomeKit's CurrentAmbientLightLevel has a minimum of 0.0001 lux. The UniFi
// sensor occasionally reports zero in pitch-dark rooms; clamp so HAP doesn't
// reject the update.
export const MIN_LUX = 0.0001;

// How many consecutive successful snapshots a device may be absent from
// before the plugin unregisters its HomeKit accessory. Default is 0 =
// never auto-remove, so transient API blips / NVR restarts / firmware
// updates never wipe a user's HomeKit room assignments and automations.
// Users who want auto-cleanup can dial this up in the Homebridge UI;
// any positive value waits that many consecutive misses before
// removing.
//
// Devices explicitly hidden via config (`hide: true`) are removed
// immediately regardless of this setting -- explicit hide is the
// reliable "I want this gone" signal.
export const DEFAULT_REMOVE_AFTER_MISSING_SNAPSHOTS = 0;

// Default button set exposed on a fob when the Integration API returns
// featureFlags.buttons empty or missing. Verified against a live USL Fob
// on Protect 7.1.60 with a thorough 4-minute capture: the six buttons
// it exposes are arm, disarm, night, panic, left, right. Per-fob
// `buttons` config overrides this; per-fob `hideButtons` trims it.
import type { FobButton } from './unifi/types';
export const DEFAULT_FOB_BUTTONS: FobButton[] = [
  'arm',
  'disarm',
  'night',
  'panic',
  'left',
  'right',
];
