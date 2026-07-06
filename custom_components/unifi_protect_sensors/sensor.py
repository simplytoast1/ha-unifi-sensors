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
    CONCENTRATION_MICROGRAMS_PER_CUBIC_METER,
    CONCENTRATION_PARTS_PER_MILLION,
    LIGHT_LUX,
    PERCENTAGE,
    EntityCategory,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import (
    UnifiProtectAirQualityCoordinator,
    UnifiProtectConfigEntry,
    UnifiProtectCoordinator,
)
from .entity import UnifiProtectSensorEntity, battery_status, is_air_quality


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
        # The UAQ is mains powered and reports no battery percentage.
        exists_fn=lambda d: not is_air_quality(d),
    ),
)


# Beta: UP Air Quality metrics, read from the internal API's ``airQuality``
# block (key = the metric name in that block). Metrics with a native HA device
# class get their name and icon from it; the index-style ones set their own.
AIR_QUALITY_DESCRIPTIONS: tuple[SensorEntityDescription, ...] = (
    SensorEntityDescription(
        key="co2",
        device_class=SensorDeviceClass.CO2,
        native_unit_of_measurement=CONCENTRATION_PARTS_PER_MILLION,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="temperature",
        device_class=SensorDeviceClass.TEMPERATURE,
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="humidity",
        device_class=SensorDeviceClass.HUMIDITY,
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="pm1p0",
        device_class=SensorDeviceClass.PM1,
        native_unit_of_measurement=CONCENTRATION_MICROGRAMS_PER_CUBIC_METER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="pm2p5",
        device_class=SensorDeviceClass.PM25,
        native_unit_of_measurement=CONCENTRATION_MICROGRAMS_PER_CUBIC_METER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="pm10p0",
        device_class=SensorDeviceClass.PM10,
        native_unit_of_measurement=CONCENTRATION_MICROGRAMS_PER_CUBIC_METER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="pm4p0",
        name="PM4.0",
        icon="mdi:air-filter",
        native_unit_of_measurement=CONCENTRATION_MICROGRAMS_PER_CUBIC_METER,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="aqi",
        device_class=SensorDeviceClass.AQI,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="voc",
        name="VOC index",
        icon="mdi:molecule",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="tvoc",
        name="TVOC index",
        icon="mdi:molecule",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="vape",
        name="Vape",
        icon="mdi:smoking",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
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

    # Beta: air-quality sensors from the local-account internal API, if enabled.
    aq_coordinator = coordinator.air_quality
    if aq_coordinator is not None:
        aq_known: set[str] = set()

        @callback
        def _discover_air_quality() -> None:
            new_aq: list[UnifiProtectAirQualitySensor] = []
            for mac, metrics in (aq_coordinator.data or {}).items():
                for description in AIR_QUALITY_DESCRIPTIONS:
                    if description.key not in metrics:
                        continue
                    unique_id = f"{mac}_aq_{description.key}"
                    if unique_id in aq_known:
                        continue
                    aq_known.add(unique_id)
                    new_aq.append(
                        UnifiProtectAirQualitySensor(aq_coordinator, mac, description)
                    )
            if new_aq:
                async_add_entities(new_aq)

        _discover_air_quality()
        entry.async_on_unload(
            aq_coordinator.async_add_listener(_discover_air_quality)
        )


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


class UnifiProtectAirQualitySensor(
    CoordinatorEntity[UnifiProtectAirQualityCoordinator], SensorEntity
):
    """A UP Air Quality reading from the internal API (beta local-account mode).

    Reads one metric out of the coordinator's ``mac -> {metric: {value, status}}``
    map. The range bucket (neutral/safe/low/high) is exposed as an attribute.
    """

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: UnifiProtectAirQualityCoordinator,
        mac: str,
        description: SensorEntityDescription,
    ) -> None:
        """Initialise the air-quality sensor."""
        super().__init__(coordinator)
        self._mac = mac
        self.entity_description = description
        self._attr_unique_id = f"{mac}_aq_{description.key}"

    @property
    def device_info(self) -> DeviceInfo:
        """Merge onto the device the API-key entities already created."""
        return DeviceInfo(identifiers={(DOMAIN, self._mac)})

    @property
    def _metric(self) -> dict[str, Any]:
        data = self.coordinator.data or {}
        return (data.get(self._mac) or {}).get(self.entity_description.key) or {}

    @property
    def available(self) -> bool:
        """Available while the last poll succeeded and the metric has a value."""
        return self.coordinator.last_update_success and isinstance(
            self._metric.get("value"), (int, float)
        )

    @property
    def native_value(self) -> float | int | None:
        """Return the current metric value."""
        value = self._metric.get("value")
        return value if isinstance(value, (int, float)) else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose the range bucket (neutral/safe/low/high) as an attribute."""
        status = self._metric.get("status")
        return {"status": status} if status is not None else None
