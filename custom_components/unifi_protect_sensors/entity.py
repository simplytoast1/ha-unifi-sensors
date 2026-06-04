"""Base entities and device helpers for UniFi Protect Sensors."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import CONNECTION_NETWORK_MAC, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MANUFACTURER
from .coordinator import UnifiProtectCoordinator


def detect_model(sensor: dict[str, Any]) -> str:
    """Infer the product name from the live capability set.

    The Integration API only reports ``modelKey: "sensor"`` with no model or
    marketing name field, so we infer it from the public fields:

    * UP Smoke: alarm enabled, every other capability disabled.
    * UP Sense: anything with motion, temperature, humidity, light, leak or
      contact (the combination sensor, and by far the most common variant).
    * UniFi Sensor: fallback when the capability set is empty.
    """
    has_alarm = bool((sensor.get("alarmSettings") or {}).get("isEnabled"))
    has_motion = bool((sensor.get("motionSettings") or {}).get("isEnabled"))
    has_temp = bool((sensor.get("temperatureSettings") or {}).get("isEnabled"))
    has_humidity = bool((sensor.get("humiditySettings") or {}).get("isEnabled"))
    has_light = bool((sensor.get("lightSettings") or {}).get("isEnabled"))
    mount = sensor.get("mountType")
    leak = sensor.get("leakSettings") or {}
    has_leak = (
        mount == "leak"
        or bool(leak.get("isInternalEnabled"))
        or bool(leak.get("isExternalEnabled"))
    )
    has_contact = mount in ("door", "window", "garage")

    sense_caps = has_motion or has_temp or has_humidity or has_light or has_leak or has_contact
    if has_alarm and not sense_caps:
        return "UP Smoke"
    if sense_caps:
        return "UP Sense"
    return "UniFi Sensor"


def battery_status(device: dict[str, Any]) -> dict[str, Any]:
    """Return the battery block, preferring the modern wireless path."""
    wireless = device.get("wirelessConnectionState") or {}
    return wireless.get("batteryStatus") or device.get("batteryStatus") or {}


def _format_mac(mac: str) -> str:
    """Render a normalised mac as colon separated for the device registry."""
    return ":".join(mac[i : i + 2] for i in range(0, len(mac), 2))


class _UnifiProtectBaseEntity(CoordinatorEntity[UnifiProtectCoordinator]):
    """Shared base: identity, availability, and device registry wiring."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: UnifiProtectCoordinator, mac: str) -> None:
        """Store the coordinator and the device's normalised mac."""
        super().__init__(coordinator)
        self._mac = mac

    @property
    def _device(self) -> dict[str, Any] | None:
        """Return the live device object, or None if it has gone away."""
        raise NotImplementedError

    @property
    def available(self) -> bool:
        """Available while the last refresh succeeded and the device exists."""
        return self.coordinator.last_update_success and self._device is not None

    def _build_device_info(self, *, model: str, name: str) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self._mac)},
            connections={(CONNECTION_NETWORK_MAC, _format_mac(self._mac))},
            manufacturer=MANUFACTURER,
            model=model,
            name=name,
            sw_version=self.coordinator.version,
            via_device=(DOMAIN, self.coordinator.config_entry.entry_id),
        )


class UnifiProtectSensorEntity(_UnifiProtectBaseEntity):
    """Base entity backed by a UniFi Protect sensor."""

    @property
    def _device(self) -> dict[str, Any] | None:
        return self.coordinator.sensors.get(self._mac)

    @property
    def device_info(self) -> DeviceInfo:
        device = self._device or {}
        name = device.get("name") or f"UniFi Sensor {self._mac}"
        return self._build_device_info(model=detect_model(device), name=name)


class UnifiProtectFobEntity(_UnifiProtectBaseEntity):
    """Base entity backed by a UniFi Protect fob."""

    @property
    def _device(self) -> dict[str, Any] | None:
        return self.coordinator.fobs.get(self._mac)

    @property
    def device_info(self) -> DeviceInfo:
        device = self._device or {}
        name = device.get("name") or f"UniFi Fob {self._mac}"
        return self._build_device_info(model="UniFi Fob", name=name)
