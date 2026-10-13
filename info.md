# UniFi Protect Sensors

Expose UniFi Protect **sensors** (UP Sense, Entry, Motion, Leak, Glass Break, Environmental, Air Quality), **relays**, and **key fobs** in Home Assistant using the official local **Integration API** on your UniFi console. Push based over the LAN, no cloud and no rate limits.

- Motion, contact (door/window/garage), leak, alarm sound, glass break, tamper, temperature, humidity, ambient light, battery, and connectivity entities, created per enabled capability.
- Relay outputs become controllable `switch` entities and dry-contact inputs become `binary_sensor` entities.
- Each fob button becomes an `event` entity you can trigger automations from.
- UI configuration: just enter your console URL and Integration API key.

Requires UniFi Protect 7.x or newer and Home Assistant 2024.12 or newer.

> Specialised on purpose. For cameras and the rest of Protect, use the built in UniFi Protect integration alongside this one.
