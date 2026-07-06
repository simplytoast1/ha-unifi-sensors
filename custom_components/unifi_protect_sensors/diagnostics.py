"""Diagnostics for UniFi Protect Sensors."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.core import HomeAssistant

from .const import CONF_API_KEY, CONF_LOCAL_PASSWORD, CONF_LOCAL_USERNAME
from .coordinator import UnifiProtectConfigEntry

TO_REDACT = {CONF_API_KEY, CONF_LOCAL_PASSWORD, CONF_LOCAL_USERNAME, "mac", "id"}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: UnifiProtectConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    coordinator = entry.runtime_data
    air_quality = coordinator.air_quality
    # Device maps are keyed by mac, which TO_REDACT is meant to hide, so emit
    # plain lists: async_redact_data only redacts values, never dict keys.
    return {
        "entry": {
            "data": async_redact_data(dict(entry.data), TO_REDACT),
            "options": async_redact_data(dict(entry.options), TO_REDACT),
        },
        "protect_version": coordinator.version,
        "sensors": async_redact_data(list(coordinator.sensors.values()), TO_REDACT),
        "fobs": async_redact_data(list(coordinator.fobs.values()), TO_REDACT),
        "relays": async_redact_data(list(coordinator.relays.values()), TO_REDACT),
        "glass_break_at": list(coordinator.glass_break_at.values()),
        "air_quality": (
            list(air_quality.data.values())
            if air_quality is not None and air_quality.data
            else None
        ),
    }
