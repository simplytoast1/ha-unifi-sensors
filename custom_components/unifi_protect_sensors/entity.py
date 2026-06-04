"""Base entities and device helpers for UniFi Protect Sensors."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import CONNECTION_NETWORK_MAC, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MANUFACTURER
from .coordinator import UnifiProtectCoordinator


def detect_model(sensor: dict[str, Any]) -> str:
    """Infer a descriptive device type from the live capability set.

    The Integration API only reports ``modelKey: "sensor"`` with no model or
    marketing name field, so the type is inferred from which capabilities the
    sensor has enabled. This reflects the deployed function, not a verified
    hardware model (the API does not expose one).
    """

    def enabled(key: str) -> bool:
        return bool((sensor.get(key) or {}).get("isEnabled"))

    mount = sensor.get("mountType")
    leak_settings = sensor.get("leakSettings") or {}
    has_glass = enabled("glassBreakSettings")
    has_alarm = enabled("alarmSettings")
    has_motion = enabled("motionSettings")
    has_environment = (
        enabled("temperatureSettings")
        or enabled("humiditySettings")
        or enabled("lightSettings")
    )
    has_leak = (
        mount == "leak"
        or bool(leak_settings.get("isInternalEnabled"))
        or bool(leak_settings.get("isExternalEnabled"))
    )
    has_contact = mount in ("door", "window", "garage")

    if has_glass:
        return "Glass Break Sensor"
    if has_contact:
        return "Contact Sensor"
    if has_leak:
        return "Leak Sensor"
    if has_alarm and not (has_motion or has_environment):
        return "Smoke/CO Alarm"
    if has_motion and has_environment:
        return "UP Sense"
    if has_motion:
        return "Motion Sensor"
    if has_environment:
        return "Environmental Sensor"
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


class UnifiProtectRelayEntity(_UnifiProtectBaseEntity):
    """Base entity backed by a UniFi relay (I/O) device."""

    @property
    def _device(self) -> dict[str, Any] | None:
        return self.coordinator.relays.get(self._mac)

    @property
    def device_info(self) -> DeviceInfo:
        device = self._device or {}
        name = device.get("name") or f"UniFi Relay {self._mac}"
        return self._build_device_info(model="UniFi Relay", name=name)
