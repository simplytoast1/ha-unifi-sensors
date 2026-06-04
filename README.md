# UniFi Protect Sensors for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![Validate](https://github.com/simplytoast1/ha-unifi-sensors/actions/workflows/validate.yml/badge.svg)](https://github.com/simplytoast1/ha-unifi-sensors/actions/workflows/validate.yml)

A Home Assistant custom integration that exposes [UniFi Protect](https://ui.com/protect) sensors (the UP Sense) and key fobs using the official **Integration API** on your local UniFi console. It talks directly to your console over the LAN, so it is push based (websocket) and not subject to the cloud API rate limits.

> **Scope:** this integration is deliberately specialised. It covers UniFi Protect sensors and key fobs only, nothing else. If you want full UniFi Protect support (cameras, doorbells, NVR events, smart detection, chimes, lights), use the built in [UniFi Protect](https://www.home-assistant.io/integrations/unifiprotect/) integration. The two can run side by side: let the built in integration own your cameras and let this one own the sensors and fobs.

## What you get

For every UniFi Protect sensor it discovers, the integration creates one Home Assistant device with entities for each enabled capability:

| Capability | Entity | Device class |
| --- | --- | --- |
| Motion | `binary_sensor` | `motion` |
| Contact (door, window, garage mount) | `binary_sensor` | `door` / `window` / `garage_door` |
| Leak | `binary_sensor` | `moisture` |
| Alarm sound (UP Smoke) | `binary_sensor` | `sound` |
| Temperature | `sensor` | `temperature` |
| Humidity | `sensor` | `humidity` |
| Ambient light | `sensor` | `illuminance` |
| Battery level | `sensor` | `battery` |
| Low battery | `binary_sensor` | `battery` |
| Connectivity | `binary_sensor` | `connectivity` |

Each paired **key fob** becomes a device with one [`event`](https://www.home-assistant.io/integrations/event/) entity per advertised button (arm, disarm, night, panic, left, right, and so on). Use the event entity as a trigger in your automations: when it fires a `press`, run whatever you like.

The UP Sense is a true combination device, so a single physical sensor can report motion, temperature, humidity, light, leak, alarm, and contact all at once. Each one maps to a single Home Assistant device carrying as many entities as it has enabled capabilities. Toggling a capability in the Protect UI adds or removes the matching entity on the next refresh.

## Supported devices

The integration reads the UniFi Protect Integration API and maps each device by the capabilities it reports live, not by a fixed model list. The API does not return a model name for sensors, so the model shown on the Home Assistant device is inferred from those capabilities (for example Leak Sensor, Motion Sensor, Glass Break Sensor, Contact Sensor, or Environmental Sensor). This is the deployed function, not a verified hardware model.

| UniFi device | Support | Entities produced |
| --- | --- | --- |
| Protect All-In-One Sensor (UP-Sense) | Full, hardware verified | Motion, contact, leak, alarm sound (smoke/CO audible), temperature, humidity, ambient light, battery, connectivity |
| Leak, Environmental, Entry and Motion sensors | Full, by capability | Whichever the device reports: leak, temperature, humidity, light, motion, contact |
| Glass Break Sensor (USL-GlassBreak) | Full | Glass-break binary sensor (from the events stream) plus its motion |
| Relay / I-O device (USL-Relay) | Full | One switch entity per output, with on and off control |
| Remote Control KeyFob (USL-FOB) | Full | One event entity per button (arm, disarm, night, panic, and so on). Only appears when a fob is paired |

The mapping is capability based: whatever a sensor reports (motion, contact, leak, temperature, humidity, ambient light, alarm sound) becomes the matching Home Assistant entity, regardless of which physical model it is. Relay outputs are exposed as switches you can toggle.

Not handled: cameras, doorbells, NVRs, lights, chimes, speakers, sirens, and the alarm hub. Cameras and doorbells are covered by Home Assistant's built-in UniFi Protect integration, which can run alongside this one.

## Requirements

- UniFi Protect 7.x or newer (the Integration API)
- An API key generated in the UniFi UI under **Settings, Control Plane, Integrations** (or in Protect under **Settings, API**)
- Home Assistant 2024.12 or newer

## Installation

### HACS (recommended)

1. In HACS, open the three dot menu and choose **Custom repositories**.
2. Add `https://github.com/simplytoast1/ha-unifi-sensors` with category **Integration**.
3. Search for **UniFi Protect Sensors**, download it, and restart Home Assistant.

### Manual

Copy `custom_components/unifi_protect_sensors` into your Home Assistant `config/custom_components` directory and restart.

## Configuration

Setup is entirely through the UI. After installing and restarting:

1. Go to **Settings, Devices & Services, Add Integration**.
2. Search for **UniFi Protect Sensors**.
3. Enter your console URL (for example `https://192.168.1.1`) and your Integration API key. Leave **Verify TLS certificate** off if your console uses the factory self signed certificate (most do).

Discovered sensors and fobs appear as devices automatically. The polling fallback interval can be changed later under the integration's **Configure** button. The integration prefers the websocket push stream and only polls when it is unavailable.

## How it works

- **Identity** is by MAC address. The MAC is the device serial and the stable key used to reconcile devices across restarts.
- **Names** come from UniFi at first discovery. After that you are free to rename devices and entities in Home Assistant; the integration does not overwrite your changes.
- **Deletion** is driven by the REST snapshot: when a sensor or fob is removed (or factory reset) in Protect, it drops out of the snapshot and its entities go unavailable. You can then remove the device from Home Assistant.
- **Momentary events** (motion, alarm, leak) are stamped with a timestamp by the API but have no explicit "ended" signal, so the integration holds the state on for a short window and then clears it.

## License

[Apache-2.0](LICENSE)
