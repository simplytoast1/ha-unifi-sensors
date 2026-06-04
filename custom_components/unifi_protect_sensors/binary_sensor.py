"""Binary sensor platform: motion, contact, leak, alarm and status."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_call_later

from .const import ALARM_HOLD, LEAK_HOLD, MOTION_HOLD
from .coordinator import UnifiProtectConfigEntry, UnifiProtectCoordinator
from .entity import UnifiProtectSensorEntity, battery_status


def _now_ms() -> float:
    return time.time() * 1000


# --- motion ---------------------------------------------------------------


def _motion_on(device: dict[str, Any]) -> bool:
    if device.get("isMotionDetected"):
        return True
    at = device.get("motionDetectedAt") or 0
    return bool(at) and (_now_ms() - at) < MOTION_HOLD * 1000


def _motion_hold(device: dict[str, Any]) -> float | None:
    at = device.get("motionDetectedAt") or 0
    return (at / 1000 + MOTION_HOLD) if at else None


# --- alarm ----------------------------------------------------------------


def _alarm_on(device: dict[str, Any]) -> bool:
    at = device.get("alarmTriggeredAt") or 0
    return bool(at) and (_now_ms() - at) < ALARM_HOLD * 1000


def _alarm_hold(device: dict[str, Any]) -> float | None:
    at = device.get("alarmTriggeredAt") or 0
    return (at / 1000 + ALARM_HOLD) if at else None


# --- leak -----------------------------------------------------------------


def _leak_at(device: dict[str, Any]) -> int:
    return max(
        device.get("leakDetectedAt") or 0,
        device.get("externalLeakDetectedAt") or 0,
    )


def _leak_on(device: dict[str, Any]) -> bool:
    at = _leak_at(device)
    return bool(at) and (_now_ms() - at) < LEAK_HOLD * 1000


def _leak_hold(device: dict[str, Any]) -> float | None:
    at = _leak_at(device)
    return (at / 1000 + LEAK_HOLD) if at else None


def _leak_exists(device: dict[str, Any]) -> bool:
    leak = device.get("leakSettings") or {}
    return (
        device.get("mountType") == "leak"
        or bool(leak.get("isInternalEnabled"))
        or bool(leak.get("isExternalEnabled"))
    )


# --- contact --------------------------------------------------------------

_CONTACT_CLASSES = {
    "door": BinarySensorDeviceClass.DOOR,
    "window": BinarySensorDeviceClass.WINDOW,
    "garage": BinarySensorDeviceClass.GARAGE_DOOR,
}


def _contact_class(device: dict[str, Any]) -> BinarySensorDeviceClass | None:
    return _CONTACT_CLASSES.get(device.get("mountType", ""))


def _capability(setting: str) -> Callable[[dict[str, Any]], bool]:
    return lambda device: bool((device.get(setting) or {}).get("isEnabled"))


@dataclass(frozen=True, kw_only=True)
class UnifiBinarySensorDescription(BinarySensorEntityDescription):
    """Describes one binary sensor, how to read it, and how it auto clears."""

    is_on_fn: Callable[[dict[str, Any]], bool]
    exists_fn: Callable[[dict[str, Any]], bool] = lambda _device: True
    device_class_fn: Callable[[dict[str, Any]], BinarySensorDeviceClass | None] | None = None
    # Returns the wall clock (epoch seconds) when an "on" state should expire,
    # so a momentary, timestamp-only event clears itself without waiting for the
    # next snapshot.
    hold_until_fn: Callable[[dict[str, Any]], float | None] | None = None


BINARY_SENSOR_DESCRIPTIONS: tuple[UnifiBinarySensorDescription, ...] = (
    UnifiBinarySensorDescription(
        key="motion",
        device_class=BinarySensorDeviceClass.MOTION,
        is_on_fn=_motion_on,
        exists_fn=_capability("motionSettings"),
        hold_until_fn=_motion_hold,
    ),
    UnifiBinarySensorDescription(
        key="contact",
        is_on_fn=lambda d: d.get("isOpened") is True,
        exists_fn=lambda d: d.get("mountType") in ("door", "window", "garage"),
        device_class_fn=_contact_class,
    ),
    UnifiBinarySensorDescription(
        key="leak",
        name="Leak",
        device_class=BinarySensorDeviceClass.MOISTURE,
        is_on_fn=_leak_on,
        exists_fn=_leak_exists,
        hold_until_fn=_leak_hold,
    ),
    UnifiBinarySensorDescription(
        key="alarm",
        name="Alarm",
        device_class=BinarySensorDeviceClass.SOUND,
        is_on_fn=_alarm_on,
        exists_fn=_capability("alarmSettings"),
        hold_until_fn=_alarm_hold,
    ),
    UnifiBinarySensorDescription(
        key="connectivity",
        device_class=BinarySensorDeviceClass.CONNECTIVITY,
        entity_category=EntityCategory.DIAGNOSTIC,
        is_on_fn=lambda d: d.get("state") == "CONNECTED",
    ),
    UnifiBinarySensorDescription(
        key="battery_low",
        name="Battery low",
        device_class=BinarySensorDeviceClass.BATTERY,
        entity_category=EntityCategory.DIAGNOSTIC,
        is_on_fn=lambda d: bool(battery_status(d).get("isLow")),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: UnifiProtectConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up binary sensors and keep up with newly discovered devices."""
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def _discover() -> None:
        new: list[UnifiProtectBinarySensor] = []
        for mac, device in coordinator.sensors.items():
            for description in BINARY_SENSOR_DESCRIPTIONS:
                if not description.exists_fn(device):
                    continue
                unique_id = f"{mac}_{description.key}"
                if unique_id in known:
                    continue
                known.add(unique_id)
                new.append(UnifiProtectBinarySensor(coordinator, mac, description))
        if new:
            async_add_entities(new)

    _discover()
    entry.async_on_unload(coordinator.async_add_listener(_discover))


class UnifiProtectBinarySensor(UnifiProtectSensorEntity, BinarySensorEntity):
    """A boolean state derived from a UniFi Protect sensor."""

    entity_description: UnifiBinarySensorDescription

    def __init__(
        self,
        coordinator: UnifiProtectCoordinator,
        mac: str,
        description: UnifiBinarySensorDescription,
    ) -> None:
        """Initialise the entity."""
        super().__init__(coordinator, mac)
        self.entity_description = description
        self._attr_unique_id = f"{mac}_{description.key}"
        self._unsub_clear: Callable[[], None] | None = None

    @property
    def available(self) -> bool:
        """Available while the capability is enabled and the device exists."""
        device = self._device
        return (
            self.coordinator.last_update_success
            and device is not None
            and self.entity_description.exists_fn(device)
        )

    @property
    def device_class(self) -> BinarySensorDeviceClass | None:
        """Resolve a per device class (contact) or fall back to the static one."""
        if self.entity_description.device_class_fn is not None:
            device = self._device
            if device is not None:
                return self.entity_description.device_class_fn(device)
        return self.entity_description.device_class

    @property
    def is_on(self) -> bool | None:
        """Return the current boolean state."""
        device = self._device
        if device is None:
            return None
        return self.entity_description.is_on_fn(device)

    async def async_added_to_hass(self) -> None:
        """Arm the auto clear timer for whatever state we start in."""
        await super().async_added_to_hass()
        self._schedule_clear()

    @callback
    def _handle_coordinator_update(self) -> None:
        self._schedule_clear()
        super()._handle_coordinator_update()

    @callback
    def _schedule_clear(self) -> None:
        if self._unsub_clear is not None:
            self._unsub_clear()
            self._unsub_clear = None
        hold_fn = self.entity_description.hold_until_fn
        device = self._device
        if hold_fn is None or device is None:
            return
        until = hold_fn(device)
        if until is None:
            return
        delay = until - time.time()
        if delay > 0:
            self._unsub_clear = async_call_later(self.hass, delay, self._clear)

    @callback
    def _clear(self, _now: Any) -> None:
        self._unsub_clear = None
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        """Cancel any pending auto clear timer."""
        if self._unsub_clear is not None:
            self._unsub_clear()
            self._unsub_clear = None
        await super().async_will_remove_from_hass()
