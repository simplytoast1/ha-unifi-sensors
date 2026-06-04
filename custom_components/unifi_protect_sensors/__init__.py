"""The UniFi Protect Sensors integration."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import UnifiProtectApiClient
from .const import (
    CONF_API_KEY,
    CONF_HOST,
    CONF_SCAN_INTERVAL,
    CONF_VERIFY_SSL,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_VERIFY_SSL,
    DOMAIN,
    PLATFORMS,
)
from .coordinator import UnifiProtectConfigEntry, UnifiProtectCoordinator


async def async_setup_entry(
    hass: HomeAssistant, entry: UnifiProtectConfigEntry
) -> bool:
    """Set up UniFi Protect Sensors from a config entry."""
    verify_ssl = entry.data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL)
    session = async_get_clientsession(hass, verify_ssl=verify_ssl)
    client = UnifiProtectApiClient(session, entry.data[CONF_HOST], entry.data[CONF_API_KEY])

    scan_interval = entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)
    coordinator = UnifiProtectCoordinator(hass, entry, client, scan_interval)
    await coordinator.async_config_entry_first_refresh()

    # Devices are registered standalone (no hub parent). Remove the legacy
    # console hub device created by earlier versions so it does not linger.
    device_registry = dr.async_get(hass)
    legacy_hub = device_registry.async_get_device(
        identifiers={(DOMAIN, entry.entry_id)}
    )
    if legacy_hub is not None:
        device_registry.async_remove_device(legacy_hub.id)

    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await coordinator.async_start()

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: UnifiProtectConfigEntry
) -> bool:
    """Tear down a config entry."""
    await entry.runtime_data.async_stop()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_update_listener(
    hass: HomeAssistant, entry: UnifiProtectConfigEntry
) -> None:
    """Reload the entry when its options change (e.g. scan interval)."""
    await hass.config_entries.async_reload(entry.entry_id)
