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
        # Protect application version, surfaced as the device sw_version.
        self.version = "0.0.0"

        self._sensor_id_to_mac: dict[str, str] = {}
        self._fob_id_to_mac: dict[str, str] = {}
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

        self.version = meta.get("applicationVersion") or self.version
        self._ingest_snapshot(sensors, fobs)
        return {"sensors": self.sensors, "fobs": self.fobs}

    @callback
    def _ingest_snapshot(
        self, sensors: list[dict[str, Any]], fobs: list[dict[str, Any]]
    ) -> None:
        new_sensors: dict[str, dict[str, Any]] = {}
        sensor_index: dict[str, str] = {}
        for sensor in sensors:
            mac = normalize_mac(sensor.get("mac"))
            if not mac:
                continue
            new_sensors[mac] = sensor
            if sensor.get("id"):
                sensor_index[sensor["id"]] = mac

        new_fobs: dict[str, dict[str, Any]] = {}
        fob_index: dict[str, str] = {}
        for fob in fobs:
            mac = normalize_mac(fob.get("mac"))
            if not mac:
                continue
            new_fobs[mac] = fob
            if fob.get("id"):
                fob_index[fob["id"]] = mac

        self.sensors = new_sensors
        self.fobs = new_fobs
        self._sensor_id_to_mac = sensor_index
        self._fob_id_to_mac = fob_index
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
                            handler(msg.data)
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
            attempts += 1
            await asyncio.sleep(delay)

    @callback
    def _handle_devices(self, raw: str) -> None:
        """Merge device state diffs and notify entities."""
        parsed = _safe_json(raw)
        if parsed is None:
            return
        sensors, fobs = _extract_devices(parsed)
        changed = False
        for partial in sensors:
            changed |= self._merge_device(partial, self.sensors, self._sensor_id_to_mac)
        for partial in fobs:
            changed |= self._merge_device(partial, self.fobs, self._fob_id_to_mac)
        if changed:
            self.async_set_updated_data({"sensors": self.sensors, "fobs": self.fobs})

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
        """Route fob button presses to the event entities."""
        parsed = _safe_json(raw)
        if parsed is None:
            return
        for event in _extract_button_events(parsed):
            button = event["metadata"]["button"]["text"]
            device_id = event.get("device")
            # The device id may be the fob or its paired alarm hub. Resolve it
            # to a fob mac when we can; otherwise dispatch with mac=None so
            # every fob that advertises the button fires (matches one fob, the
            # common case, exactly).
            mac = self._fob_id_to_mac.get(device_id or "")
            async_dispatcher_send(
                self.hass,
                SIGNAL_FOB_BUTTON.format(self.config_entry.entry_id),
                mac,
                button,
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
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Walk an arbitrary payload and split out sensor and fob objects.

    The ``modelKey`` field is the discriminator. Other device types (camera,
    chime, light, ...) are ignored: this integration does not expose them.
    """
    sensors: list[dict[str, Any]] = []
    fobs: list[dict[str, Any]] = []

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
        for key in ("item", "items", "data", "sensors", "fobs"):
            if key in node:
                walk(node[key])

    walk(parsed)
    return sensors, fobs


def _extract_button_events(parsed: Any) -> list[dict[str, Any]]:
    """Pull every fob button press event out of a payload."""
    events: list[dict[str, Any]] = []

    def is_button_event(obj: dict[str, Any]) -> bool:
        if obj.get("modelKey") != "event":
            return False
        if obj.get("type") not in ("alarmHubButtonPress", "sensorButtonPressed"):
            return False
        button = (obj.get("metadata") or {}).get("button")
        return isinstance(button, dict) and bool(button.get("text"))

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if is_button_event(node):
            events.append(node)
            return
        for key in ("item", "items"):
            if key in node:
                walk(node[key])

    walk(parsed)
    return events
