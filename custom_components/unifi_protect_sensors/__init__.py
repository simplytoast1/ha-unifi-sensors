"""The UniFi Protect Sensors integration."""

from __future__ import annotations

import aiohttp

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.aiohttp_client import (
    async_create_clientsession,
    async_get_clientsession,
)

from .api import UnifiProtectApiClient
from .const import (
    CONF_API_KEY,
    CONF_HOST,
    CONF_LOCAL_ENABLED,
    CONF_LOCAL_PASSWORD,
    CONF_LOCAL_USERNAME,
    CONF_SCAN_INTERVAL,
    CONF_VERIFY_SSL,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_VERIFY_SSL,
    DOMAIN,
    PLATFORMS,
)
from .coordinator import (
    UnifiProtectAirQualityCoordinator,
    UnifiProtectConfigEntry,
    UnifiProtectCoordinator,
)
from .entity import detect_model, is_air_quality
from .internal_api import UnifiProtectInternalClient

# Capabilities pre-0.5.0 versions wrongly created on the UP Air Quality sensor
# (it looks like a leak sensor over the API key), mapped to their entity domain.
# Removed from the registry on setup so upgrades do not keep a phantom leak or
# battery entity lingering as "unavailable".
_STALE_UAQ_ENTITIES = {
    "leak": "binary_sensor",
    "battery_low": "binary_sensor",
    "battery": "sensor",
}


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

    _cleanup_suppressed_uaq_entities(hass, coordinator)

    entry.runtime_data = coordinator

    # Optional beta: a local account unlocks the UP Air Quality readings that the
    # API key cannot see. Isolated so a failure here never affects the key path.
    await _async_setup_air_quality(hass, entry, coordinator, verify_ssl)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await coordinator.async_start()

    # Keep device names, models and firmware in sync without a reload when they
    # change in UniFi. Home Assistant only applies device_info at entity
    # creation, so reconcile the device registry on every coordinator update. A
    # name you set in Home Assistant is preserved: it lives in name_by_user,
    # which this never touches.
    @callback
    def _reconcile_devices() -> None:
        version = coordinator.version

        def sync(mac: str, name: str, model: str) -> None:
            device = device_registry.async_get_device(identifiers={(DOMAIN, mac)})
            if device is None:
                return
            updates: dict[str, str] = {}
            if name and device.name != name:
                updates["name"] = name
            if model and device.model != model:
                updates["model"] = model
            if version and device.sw_version != version:
                updates["sw_version"] = version
            if updates:
                device_registry.async_update_device(device.id, **updates)

        for mac, sensor in coordinator.sensors.items():
            sync(mac, sensor.get("name") or f"UniFi Sensor {mac}", detect_model(sensor))
        for mac, fob in coordinator.fobs.items():
            sync(mac, fob.get("name") or f"UniFi Fob {mac}", "UniFi Fob")
        for mac, relay in coordinator.relays.items():
            sync(mac, relay.get("name") or f"UniFi Relay {mac}", "UniFi Relay")

    _reconcile_devices()
    entry.async_on_unload(coordinator.async_add_listener(_reconcile_devices))

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


@callback
def _cleanup_suppressed_uaq_entities(
    hass: HomeAssistant, coordinator: UnifiProtectCoordinator
) -> None:
    """Remove leak/battery entities left on UAQ devices by pre-0.5.0 versions."""
    entity_registry = er.async_get(hass)
    for mac, sensor in coordinator.sensors.items():
        if not is_air_quality(sensor):
            continue
        for suffix, domain in _STALE_UAQ_ENTITIES.items():
            entity_id = entity_registry.async_get_entity_id(
                domain, DOMAIN, f"{mac}_{suffix}"
            )
            if entity_id is not None:
                entity_registry.async_remove(entity_id)


async def _async_setup_air_quality(
    hass: HomeAssistant,
    entry: UnifiProtectConfigEntry,
    coordinator: UnifiProtectCoordinator,
    verify_ssl: bool,
) -> None:
    """Stand up the beta air-quality coordinator when a local account is set."""
    if not entry.options.get(CONF_LOCAL_ENABLED):
        return
    username = entry.options.get(CONF_LOCAL_USERNAME)
    password = entry.options.get(CONF_LOCAL_PASSWORD)
    if not username or not password:
        return

    # A dedicated session with an unsafe cookie jar so the session cookie is
    # kept for IP-address hosts and never mixes with the shared key session.
    session = async_create_clientsession(
        hass, verify_ssl=verify_ssl, cookie_jar=aiohttp.CookieJar(unsafe=True)
    )
    client = UnifiProtectInternalClient(
        session, entry.data[CONF_HOST], username, password
    )
    aq_coordinator = UnifiProtectAirQualityCoordinator(
        hass, entry, client, coordinator
    )
    coordinator.air_quality = aq_coordinator
    # async_refresh (not first_refresh): a beta failure must not abort setup.
    await aq_coordinator.async_refresh()


async def async_unload_entry(
    hass: HomeAssistant, entry: UnifiProtectConfigEntry
) -> bool:
    """Tear down a config entry."""
    coordinator = entry.runtime_data
    await coordinator.async_stop()
    if coordinator.air_quality is not None:
        await coordinator.air_quality.client.async_close()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_update_listener(
    hass: HomeAssistant, entry: UnifiProtectConfigEntry
) -> None:
    """Reload the entry when its options change (e.g. scan interval)."""
    await hass.config_entries.async_reload(entry.entry_id)
