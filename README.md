# homebridge-unifi-sensors

A Homebridge dynamic platform plugin that exposes [UniFi Protect](https://ui.com/protect) sensors (the UP Sense) to HomeKit using the official **Integration API** on your local UniFi console. Talks directly to your NVR over the LAN, so it is not subject to the cloud API rate limits.

> **Scope:** this plugin is deliberately specialised. It covers UniFi Protect sensors and key fobs only — nothing else. If you want full UniFi Protect support in HomeKit (cameras, doorbells, NVR-level events, HKSV, smart-detection, chimes, lights, etc.), use [hjdhjd/homebridge-unifi-protect](https://github.com/hjdhjd/homebridge-unifi-protect), which is the actively maintained, comprehensive UniFi Protect plugin for Homebridge. The two plugins can run side by side: point `homebridge-unifi-protect` at your cameras and let this plugin own the sensors.

## What it does

For every UniFi Protect sensor it discovers, the plugin creates one HomeKit accessory with the right services for that sensor's enabled capabilities:

- Motion (`MotionSensor`)
- Contact, when mounted on a door, window, or garage (`ContactSensor`)
- Leak, when mounted as a leak probe (`LeakSensor`, with a per-sensor option to expose it as a `ContactSensor` instead)
- Temperature (`TemperatureSensor`)
- Humidity (`HumiditySensor`)
- Light (`LightSensor`)
- Alarm sound, when enabled (`ContactSensor` that pulses on detection)
- Battery (`Battery` service with low-battery flag)

It also discovers UniFi Protect **fobs** (key fobs paired to the alarm system) and exposes each button as a HomeKit `Stateless Programmable Switch` so you can build automations off arm, disarm, panic, and any other buttons the fob model advertises.

Each accessory carries the right HomeKit identity:

- Manufacturer: Ubiquiti
- Model: from the sensor's marketing name
- Serial number: the sensor's MAC
- Firmware revision: from the UniFi Protect API

## Requirements

- UniFi Protect 7.x or newer (Integration API)
- An API key generated in the UniFi Network or Protect UI (Settings -> API)
- Homebridge 1.8+ or 2.0+
- Node 20 or 22

## Install

```sh
npm install -g homebridge-unifi-sensors
```

Or via the Homebridge UI: search for "UniFi Sensors".

## Configure

Use the Homebridge Config UI form. Minimum required:

```json
{
  "platform": "UnifiSensors",
  "name": "UniFi Sensors",
  "host": "https://nvr.example.com",
  "apiKey": "your-integration-api-key"
}
```

After the first launch the plugin logs each discovered sensor with its MAC, so you can copy it into the `sensors` array to hide it or customize its capabilities:

```json
{
  "platform": "UnifiSensors",
  "host": "https://nvr.example.com",
  "apiKey": "...",
  "pollIntervalSeconds": 5,
  "sensors": [
    {
      "mac": "ac8bf603abcd",
      "hide": false,
      "hideMotion": false,
      "hideTemperature": true,
      "exposeLeakAsContact": false
    }
  ]
}
```

Set `hide: true` on a sensor to remove it from HomeKit entirely. Set `hideTemperature`, `hideHumidity`, `hideLight`, `hideMotion`, `hideContact`, `hideLeak`, or `hideAlarm` to remove individual capabilities. Set `exposeLeakAsContact: true` on a leak-mode sensor to surface it in HomeKit as a contact sensor instead of a leak sensor.

## Combination sensors

The UP Sense is a true combination device. A single physical sensor can report motion, temperature, humidity, ambient light, leak, smoke/CO alarm sound, and contact (when mounted on a door, window, or garage) all at once. The plugin maps that 1:1: each UniFi sensor becomes one HomeKit accessory carrying as many HomeKit services as it has enabled capabilities. Toggling a capability on or off in the Protect UI adds or removes the matching service without a Homebridge restart.

## Fobs and buttons

Each UniFi Protect fob (the wireless key fob paired to your alarm hub) becomes a HomeKit accessory carrying:

- An `AccessoryInformation` block with the fob's MAC as the serial number.
- A `Battery` service.
- One `Stateless Programmable Switch` service per button the fob model advertises in `featureFlags.buttons`. Possible values per the official spec: `function`, `alarmHubButton`, `arm`, `disarm`, `night`, `panic`, `left`, `right`, `input1`, `input2`. Each button is given a stable `ServiceLabelIndex` so the Home app's "Allow Automation" picker lists them in a consistent order.

When a button is pressed the plugin fires a single press on the matching HomeKit programmable switch. Per-fob `hide` and per-button toggles live in the Homebridge UI under the device list.

## Detected device types

The UniFi Protect Integration API returns every sensor as `modelKey: "sensor"` with no dedicated model or marketing-name field, so the plugin infers the product from the live capability profile:

- **UP Smoke** — alarm enabled, every other capability disabled.
- **UP Sense** — anything that has motion, temperature, humidity, light, leak, or contact (the combination sensor and the most common variant).
- **UniFi Sensor** — fallback label when the capability set is empty.

The detected model lands in HomeKit's `Model` field on the accessory and is also logged once at discovery alongside the full capability list, so you can confirm at a glance that the plugin sees the same picture as the UniFi UI.

## Name sync

Names flow one way, UniFi to HomeKit, and only at first discovery. When a sensor is first picked up, the plugin uses the UniFi name (or the `config.name` override, if set) as the accessory's display name and as the initial name on each service. After that the plugin does not overwrite the name on subsequent refreshes, so any rename you make in the Home app sticks.

If you want a name that survives both UniFi renames and Home app renames, set the `name` field on the per-sensor config entry. That value is treated as authoritative and wins every refresh.

## Deletion

The plugin reconciles HomeKit against the live UniFi snapshot on every poll. An accessory disappears from HomeKit when:

- The sensor is deleted (or factory-reset) in the UniFi Protect app, so it no longer appears in `GET /v1/sensors`.
- The user sets `hide: true` on its config entry.
- A cached accessory file references a MAC that no longer maps to any sensor.

In every case the accessory is properly unregistered (`unregisterPlatformAccessories`) so HomeKit garbage-collects the room assignment and Home app removes the tile.

## License

Apache-2.0
