"""Sensor platform: temperature, humidity, illuminance and battery."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import (
    LIGHT_LUX,
    PERCENTAGE,
    EntityCategory,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import UnifiProtectConfigEntry, UnifiProtectCoordinator
from .entity import UnifiProtectSensorEntity, battery_status


def _metric(device: dict[str, Any], key: str) -> float | None:
    value = ((device.get("stats") or {}).get(key) or {}).get("value")
    return value if isinstance(value, (int, float)) else None


def _battery_level(device: dict[str, Any]) -> int | None:
    pct = battery_status(device).get("percentage")
    return int(pct) if isinstance(pct, (int, float)) else None


@dataclass(frozen=True, kw_only=True)
class UnifiSensorDescription(SensorEntityDescription):
    """Describes one sensor entity and how to read/gate it."""

    value_fn: Callable[[dict[str, Any]], float | int | None]
    exists_fn: Callable[[dict[str, Any]], bool] = lambda _device: True


def _capability(setting: str) -> Callable[[dict[str, Any]], bool]:
    return lambda device: bool((device.get(setting) or {}).get("isEnabled"))


SENSOR_DESCRIPTIONS: tuple[UnifiSensorDescription, ...] = (
    UnifiSensorDescription(
        key="temperature",
        device_class=SensorDeviceClass.TEMPERATURE,
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: _metric(d, "temperature"),
        exists_fn=_capability("temperatureSettings"),
    ),
    UnifiSensorDescription(
        key="humidity",
        device_class=SensorDeviceClass.HUMIDITY,
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: _metric(d, "humidity"),
        exists_fn=_capability("humiditySettings"),
    ),
    UnifiSensorDescription(
        key="illuminance",
        device_class=SensorDeviceClass.ILLUMINANCE,
        native_unit_of_measurement=LIGHT_LUX,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: _metric(d, "light"),
        exists_fn=_capability("lightSettings"),
    ),
    UnifiSensorDescription(
        key="battery",
        device_class=SensorDeviceClass.BATTERY,
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=_battery_level,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: UnifiProtectConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up sensor entities and keep up with newly discovered devices."""
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def _discover() -> None:
        new: list[UnifiProtectSensor] = []
        for mac, device in coordinator.sensors.items():
            for description in SENSOR_DESCRIPTIONS:
                if not description.exists_fn(device):
                    continue
                unique_id = f"{mac}_{description.key}"
                if unique_id in known:
                    continue
                known.add(unique_id)
                new.append(UnifiProtectSensor(coordinator, mac, description))
        if new:
            async_add_entities(new)

    _discover()
    entry.async_on_unload(coordinator.async_add_listener(_discover))


class UnifiProtectSensor(UnifiProtectSensorEntity, SensorEntity):
    """A numeric reading from a UniFi Protect sensor."""

    entity_description: UnifiSensorDescription

    def __init__(
        self,
        coordinator: UnifiProtectCoordinator,
        mac: str,
        description: UnifiSensorDescription,
    ) -> None:
        """Initialise the entity."""
        super().__init__(coordinator, mac)
        self.entity_description = description
        self._attr_unique_id = f"{mac}_{description.key}"

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
    def native_value(self) -> float | int | None:
        """Return the current reading."""
        device = self._device
        if device is None:
            return None
        return self.entity_description.value_fn(device)
