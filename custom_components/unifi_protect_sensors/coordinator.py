"""Data coordinator for UniFi Protect Sensors.

Combines two data paths into one source of truth that entities read from:

* REST snapshots (``_async_update_data``) run on a slow interval and on demand.
  They are authoritative: each snapshot fully replaces the sensor/fob state, so
  devices removed in Protect simply drop out of the maps.
* Two websockets push live changes between snapshots. The ``devices`` stream
  carries partial sensor/fob diffs that are merged into the maps; the
  ``events`` stream carries fob button presses that are dispatched to the event
  entities.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
import json
import logging
import time
from typing import Any

import aiohttp

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import UnifiProtectApiClient, UnifiProtectApiError, UnifiProtectAuthError
from .const import DOMAIN, SIGNAL_FOB_BUTTON

_LOGGER = logging.getLogger(__name__)

WS_BACKOFF_BASE = 5
WS_BACKOFF_MAX = 60

type UnifiProtectConfigEntry = ConfigEntry["UnifiProtectCoordinator"]


def normalize_mac(mac: str | None) -> str:
    """Strip separators and lowercase a MAC so it is a stable map key."""
    if not mac:
        return ""
    return "".join(c for c in mac.lower() if c in "0123456789abcdef")


class UnifiProtectCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Owns connection state and the live sensor/fob maps."""

    config_entry: UnifiProtectConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        entry: UnifiProtectConfigEntry,
        client: UnifiProtectApiClient,
        scan_interval: int,
    ) -> None:
        """Initialise the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=timedelta(seconds=scan_interval),
        )
        self.client = client
        # mac -> latest full device object.
        self.sensors: dict[str, dict[str, Any]] = {}
        self.fobs: dict[str, dict[str, Any]] = {}
        self.relays: dict[str, dict[str, Any]] = {}
        # Protect application version, surfaced as the device sw_version.
        self.version = "0.0.0"
        # mac -> epoch ms of the last glass-break event. Glass break arrives on
        # the events websocket only; the sensor object has no field for it.
        self.glass_break_at: dict[str, float] = {}

        self._sensor_id_to_mac: dict[str, str] = {}
        self._fob_id_to_mac: dict[str, str] = {}
        self._relay_id_to_mac: dict[str, str] = {}
        # ids seen on the websocket that the REST snapshot does not return, so
        # we trigger at most one refetch per id rather than a refetch storm.
        self._unknown_ids: set[str] = set()
        self._closing = False

    # ------------------------------------------------------------------
    # REST snapshot path
    # ------------------------------------------------------------------

    async def _async_update_data(self) -> dict[str, Any]:
        """Pull a full snapshot of meta, sensors and fobs."""
        try:
            meta = await self.client.async_get_meta()
            sensors = await self.client.async_get_sensors()
            fobs = await self.client.async_get_fobs()
        except UnifiProtectAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except UnifiProtectApiError as err:
            raise UpdateFailed(str(err)) from err

        # Relays are a newer endpoint; tolerate consoles that do not expose it.
        try:
            relays = await self.client.async_get_relays()
        except UnifiProtectAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except UnifiProtectApiError:
            relays = []

        self.version = meta.get("applicationVersion") or self.version
        self._ingest_snapshot(sensors, fobs, relays)
        return {"sensors": self.sensors, "fobs": self.fobs, "relays": self.relays}

    @callback
    def _ingest_snapshot(
        self,
        sensors: list[dict[str, Any]],
        fobs: list[dict[str, Any]],
        relays: list[dict[str, Any]],
    ) -> None:
        def indexed(
            items: list[dict[str, Any]],
        ) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
            store: dict[str, dict[str, Any]] = {}
            id_to_mac: dict[str, str] = {}
            for item in items:
                mac = normalize_mac(item.get("mac"))
                if not mac:
                    continue
                store[mac] = item
                if item.get("id"):
                    id_to_mac[item["id"]] = mac
            return store, id_to_mac

        self.sensors, self._sensor_id_to_mac = indexed(sensors)
        self.fobs, self._fob_id_to_mac = indexed(fobs)
        self.relays, self._relay_id_to_mac = indexed(relays)
        self.glass_break_at = {
            mac: at for mac, at in self.glass_break_at.items() if mac in self.sensors
        }
        self._unknown_ids.clear()

    # ------------------------------------------------------------------
    # Websockets
    # ------------------------------------------------------------------

    async def async_start(self) -> None:
        """Launch the two websocket listeners as entry background tasks."""
        self.config_entry.async_create_background_task(
            self.hass, self._run_ws(self.client.devices_ws_url, self._handle_devices),
            f"{DOMAIN}_devices_ws",
        )
        self.config_entry.async_create_background_task(
            self.hass, self._run_ws(self.client.events_ws_url, self._handle_events),
            f"{DOMAIN}_events_ws",
        )

    async def async_stop(self) -> None:
        """Signal the websocket loops to exit (tasks are cancelled by HA)."""
        self._closing = True

    async def _run_ws(self, url: str, handler) -> None:
        """Maintain one websocket with exponential backoff reconnect."""
        attempts = 0
        while not self._closing:
            try:
                async with self.client.ws_connect(url) as ws:
                    attempts = 0
                    _LOGGER.debug("Websocket connected: %s", url)
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            # A bad payload must not tear down the connection.
                            try:
                                handler(msg.data)
                            except Exception:  # noqa: BLE001
                                _LOGGER.warning(
                                    "Error handling websocket message from %s",
                                    url,
                                    exc_info=True,
                                )
                        elif msg.type in (
                            aiohttp.WSMsgType.CLOSE,
                            aiohttp.WSMsgType.CLOSED,
                            aiohttp.WSMsgType.ERROR,
                        ):
                            break
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - log and reconnect on anything
                _LOGGER.debug("Websocket error on %s: %s", url, err)

            if self._closing:
                break
            delay = min(WS_BACKOFF_MAX, WS_BACKOFF_BASE * 2**attempts)
            attempts = min(attempts + 1, 4)
            await asyncio.sleep(delay)

    @callback
    def _handle_devices(self, raw: str) -> None:
        """Merge device state diffs and notify entities."""
        parsed = _safe_json(raw)
        if parsed is None:
            return
        sensors, fobs, relays = _extract_devices(parsed)
        changed = False
        for partial in sensors:
            changed |= self._merge_device(partial, self.sensors, self._sensor_id_to_mac)
        for partial in fobs:
            changed |= self._merge_device(partial, self.fobs, self._fob_id_to_mac)
        for partial in relays:
            changed |= self._merge_device(partial, self.relays, self._relay_id_to_mac)
        if changed:
            self.async_set_updated_data(
                {"sensors": self.sensors, "fobs": self.fobs, "relays": self.relays}
            )

    def _merge_device(
        self,
        partial: dict[str, Any],
        store: dict[str, dict[str, Any]],
        index: dict[str, str],
    ) -> bool:
        device_id = partial.get("id")
        mac = normalize_mac(partial.get("mac")) or index.get(device_id or "", "")
        if not mac or mac not in store:
            # A diff for a device the last snapshot did not return. Refetch
            # once so it can be added, but never loop on a phantom id.
            if device_id and device_id not in self._unknown_ids:
                self._unknown_ids.add(device_id)
                self.hass.async_create_task(self.async_request_refresh())
            return False
        store[mac].update(partial)
        if device_id:
            index[device_id] = mac
        return True

    @callback
    def _handle_events(self, raw: str) -> None:
        """Route fob button presses and glass-break events to entities."""
        parsed = _safe_json(raw)
        if parsed is None:
            return
        glass_changed = False
        for event in _extract_events(parsed):
            etype = event.get("type")
            meta = event.get("metadata") or {}

            # Fob button press. The device id may be the fob or its paired
            # alarm hub; resolve to a fob mac when we can, otherwise dispatch
            # with mac=None so every fob advertising the button fires (matches
            # the single-fob case exactly).
            button = (meta.get("button") or {}).get("text")
            if etype in ("alarmHubButtonPress", "sensorButtonPressed") and button:
                device_id = event.get("device")
                mac = (
                    self._fob_id_to_mac.get(device_id)
                    if isinstance(device_id, str)
                    else None
                )
                async_dispatcher_send(
                    self.hass,
                    SIGNAL_FOB_BUTTON.format(self.config_entry.entry_id),
                    mac,
                    button,
                )
                continue

            # Glass break. Arrives as a sensor-level sensorAlarm (device is the
            # sensor) or an alarm-hub event (the sensor id is in
            # metadata.deviceId). There is no glass-break field on the sensor
            # object, so stamp the time here and let the entity hold it.
            alarm_type = (meta.get("alarmType") or {}).get("text")
            if etype == "alarmHubGlassBreak" or alarm_type == "glassBreak":
                device_ref = meta.get("deviceId")
                sensor_id = (
                    device_ref.get("text") if isinstance(device_ref, dict) else None
                ) or event.get("device")
                mac = (
                    self._sensor_id_to_mac.get(sensor_id)
                    if isinstance(sensor_id, str)
                    else None
                )
                if mac:
                    self.glass_break_at[mac] = _event_time(event)
                    glass_changed = True
                    _LOGGER.debug("Glass break detected on sensor %s", mac)

        if glass_changed:
            self.async_set_updated_data(
                {"sensors": self.sensors, "fobs": self.fobs, "relays": self.relays}
            )


def _safe_json(raw: str) -> Any:
    text = raw.strip()
    if not text or text[0] not in "{[":
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _extract_devices(
    parsed: Any,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Walk an arbitrary payload and split out sensor, fob and relay objects.

    The ``modelKey`` field is the discriminator. Other device types (camera,
    chime, light, ...) are ignored: this integration does not expose them.
    """
    sensors: list[dict[str, Any]] = []
    fobs: list[dict[str, Any]] = []
    relays: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if isinstance(node.get("id"), str):
            if node.get("modelKey") == "sensor":
                sensors.append(node)
                return
            if node.get("modelKey") == "fob":
                fobs.append(node)
                return
            if node.get("modelKey") == "relay":
                relays.append(node)
                return
        for key in ("item", "items", "data", "sensors", "fobs", "relays"):
            if key in node:
                walk(node[key])

    walk(parsed)
    return sensors, fobs, relays


def _event_time(event: dict[str, Any]) -> float:
    """Epoch ms for an event: its ``start`` if present, else now."""
    start = event.get("start")
    return float(start) if isinstance(start, (int, float)) else time.time() * 1000


def _extract_events(parsed: Any) -> list[dict[str, Any]]:
    """Pull every event-log record (modelKey 'event') out of a payload."""
    events: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if node.get("modelKey") == "event" and node.get("type"):
            events.append(node)
            return
        for key in ("item", "items"):
            if key in node:
                walk(node[key])

    walk(parsed)
    return events
