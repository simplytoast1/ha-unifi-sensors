"""Diagnostics for UniFi Protect Sensors."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.core import HomeAssistant

from .const import CONF_API_KEY
from .coordinator import UnifiProtectConfigEntry

TO_REDACT = {CONF_API_KEY, "mac", "id"}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: UnifiProtectConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    coordinator = entry.runtime_data
    return {
        "entry": {
            "data": async_redact_data(dict(entry.data), TO_REDACT),
            "options": dict(entry.options),
        },
        "protect_version": coordinator.version,
        "sensors": async_redact_data(coordinator.sensors, TO_REDACT),
        "fobs": async_redact_data(coordinator.fobs, TO_REDACT),
        "relays": async_redact_data(coordinator.relays, TO_REDACT),
    }
