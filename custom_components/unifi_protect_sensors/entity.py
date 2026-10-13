"""Base entities and device helpers for UniFi Protect Sensors."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import CONNECTION_NETWORK_MAC, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MANUFACTURER
from .coordinator import UnifiProtectCoordinator


def has_feature(device: dict[str, Any], flag: str) -> bool | None:
    """Check Protect 7.3+ sensorFeatureFlags for a capability slice.

    Returns True when the flag has a positive channelCount, False when
    featureFlags is present and the flag is absent, or None on older firmware
    that does not populate featureFlags yet.
    """
    flags = device.get("featureFlags")
    if not isinstance(flags, dict) or not flags:
        return None
    cap = flags.get(flag)
    return isinstance(cap, dict) and (cap.get("channelCount") or 0) > 0


def detect_model(sensor: dict[str, Any]) -> str:
    """Infer a descriptive device type from the live capability set.

    Prefers the hardware ``type`` string when the API populates it, and falls
    back to inferring the deployed function from ``featureFlags`` and enabled
    capability blocks.
    """
    hw_type = sensor.get("type")
    if isinstance(hw_type, str) and hw_type.strip():
        return hw_type.strip()

    def enabled(key: str) -> bool:
        return bool((sensor.get(key) or {}).get("isEnabled"))

    if is_air_quality(sensor):
        return "Air Quality Sensor"

    mount = sensor.get("mountType")
    leak_settings = sensor.get("leakSettings") or {}
    has_glass = enabled("glassBreakSettings")
    has_alarm = has_feature(sensor, "smoke") is True or enabled("alarmSettings")
    has_motion = has_feature(sensor, "motion") is True or enabled("motionSettings")
    has_environment = (
        has_feature(sensor, "temperature") is True
        or has_feature(sensor, "humidity") is True
        or has_feature(sensor, "light") is True
        or enabled("temperatureSettings")
        or enabled("humiditySettings")
        or enabled("lightSettings")
    )
    has_leak = (
        has_feature(sensor, "waterLeak") is True
        or mount == "leak"
        or bool(leak_settings.get("isInternalEnabled"))
        or bool(leak_settings.get("isExternalEnabled"))
    )
    has_contact = (
        has_feature(sensor, "open") is True
        or mount in ("door", "window", "garage")
    )

    if has_glass:
        return "Glass Break Sensor"
    if has_contact and not (has_motion or has_environment or has_leak or has_alarm):
        return "Contact Sensor"
    if has_leak and not (has_motion or has_environment or has_contact or has_alarm):
        return "Leak Sensor"
    if has_alarm and not (has_motion or has_environment):
        return "Smoke/CO Alarm"
    if has_motion and has_environment:
        return "UP Sense"
    if has_contact:
        return "Contact Sensor"
    if has_leak:
        return "Leak Sensor"
    if has_motion:
        return "Motion Sensor"
    if has_environment:
        return "Environmental Sensor"
    return "UniFi Sensor"


def battery_status(device: dict[str, Any]) -> dict[str, Any]:
    """Return the battery block, preferring the modern wireless path."""
    wireless = device.get("wirelessConnectionState") or {}
    return wireless.get("batteryStatus") or device.get("batteryStatus") or {}


def has_battery(device: dict[str, Any]) -> bool:
    """True for battery-powered devices (all sensors/fobs except the mains UAQ)."""
    return not is_air_quality(device)


def is_air_quality(sensor: dict[str, Any]) -> bool:
    """True for the UniFi Air Quality (UAQ) monitor.

    Over the Integration API the UAQ is reported as ``modelKey: "sensor"`` with
    ``mountType: "none"``, no battery percentage, no bridge, and only
    ``leakSettings.isInternalEnabled`` set (on Protect 7.3+ ``featureFlags``
    carries ``waterLeak`` and ``tamper``). Dedicated entry/contact sensors (like
    the USL Entry Recessed) or offline battery sensors can also report a null
    battery percentage and no bridge, so we strictly require ``mountType`` to be
    ``"none"`` (or unset), no contact/motion/glass/alarm/stats capabilities, and
    ``leakSettings.isInternalEnabled`` to be true.
    """
    hw_type = (sensor.get("type") or "").upper()
    if hw_type:
        return "UAQ" in hw_type or "AIR" in hw_type

    wireless = sensor.get("wirelessConnectionState") or {}
    if wireless.get("bridge"):
        return False
    if battery_status(sensor).get("percentage") is not None:
        return False

    # Any contact mount (door, window, garage) or explicit leak mount is never
    # an Air Quality monitor.
    mount = sensor.get("mountType")
    if mount not in (None, "none"):
        return False
    if sensor.get("isOpened") is not None or sensor.get("openStatusChangedAt") is not None:
        return False

    # Protect 7.3+ populates featureFlags with supported capability channels.
    # A sensor advertising open, motion, light, or smoke is not a UAQ.
    flags = sensor.get("featureFlags")
    if isinstance(flags, dict) and flags:
        if any(
            flags.get(k)
            for k in ("open", "motion", "light", "smoke", "temperature", "humidity")
        ):
            return False

    # None of the non-UAQ sensor settings may be enabled.
    for setting in (
        "motionSettings",
        "temperatureSettings",
        "humiditySettings",
        "lightSettings",
        "alarmSettings",
        "glassBreakSettings",
    ):
        if (sensor.get(setting) or {}).get("isEnabled"):
            return False

    # The UAQ always reports leakSettings.isInternalEnabled=True (and never
    # external leak) over the Integration API.
    leak = sensor.get("leakSettings") or {}
    if not leak.get("isInternalEnabled") or leak.get("isExternalEnabled"):
        return False

    return True


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
        model = (device.get("type") or "").strip() or "UniFi Fob"
        return self._build_device_info(model=model, name=name)


class UnifiProtectRelayEntity(_UnifiProtectBaseEntity):
    """Base entity backed by a UniFi relay (I/O) device."""

    @property
    def _device(self) -> dict[str, Any] | None:
        return self.coordinator.relays.get(self._mac)

    @property
    def device_info(self) -> DeviceInfo:
        device = self._device or {}
        name = device.get("name") or f"UniFi Relay {self._mac}"
        model = (device.get("type") or "").strip() or "UniFi Relay"
        return self._build_device_info(model=model, name=name)
