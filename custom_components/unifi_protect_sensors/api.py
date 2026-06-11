"""Async client for the UniFi Protect Integration API (v1).

The Integration API is the official, locally hosted API exposed by UniFi
Protect 7.x consoles. It differs from the legacy ``/proxy/protect/api`` used by
older tools:

* Authentication is a single per console API key (the ``X-API-KEY`` header).
  There is no username/password bootstrap and no CSRF dance.
* The base path is ``/proxy/protect/integration/v1/``.
* Requests made directly to the console over the LAN are not rate limited by
  the cloud proxy, which is why this integration talks to the console directly.

Only the handful of endpoints this integration actually uses are implemented
here, keeping the surface area small.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import aiohttp

_LOGGER = logging.getLogger(__name__)

INTEGRATION_PATH = "/proxy/protect/integration/v1/"
REQUEST_TIMEOUT = 15
WS_HEARTBEAT = 30


class UnifiProtectApiError(Exception):
    """Raised for any non 2xx response or transport failure."""

    def __init__(self, message: str, status: int | None = None) -> None:
        """Store the message and optional HTTP status."""
        super().__init__(message)
        self.status = status


class UnifiProtectAuthError(UnifiProtectApiError):
    """Raised when the console rejects the API key (HTTP 401/403)."""


class UnifiProtectApiClient:
    """REST and websocket access to one UniFi console's Integration API."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        api_key: str,
    ) -> None:
        """Initialise the client.

        ``session`` should already be configured for the console's TLS posture
        (most consoles use a self signed certificate, so the caller passes a
        session created with ``verify_ssl=False``).
        """
        host = host.strip().rstrip("/")
        if "://" not in host:
            host = "https://" + host
        self._session = session
        self._base = host + INTEGRATION_PATH
        self._api_key = api_key.strip()
        self._headers = {
            "X-API-KEY": self._api_key,
            "Accept": "application/json",
        }

    @property
    def headers(self) -> dict[str, str]:
        """Return a copy of the auth headers (used for websocket handshakes)."""
        return dict(self._headers)

    def _ws_url(self, suffix: str) -> str:
        scheme, netloc, path, query, _ = urlsplit(self._base + suffix)
        ws_scheme = "wss" if scheme == "https" else "ws"
        return urlunsplit((ws_scheme, netloc, path, query, ""))

    @property
    def devices_ws_url(self) -> str:
        """Websocket URL for the device state stream (sensor/fob diffs)."""
        return self._ws_url("subscribe/devices")

    @property
    def events_ws_url(self) -> str:
        """Websocket URL for the event log stream (button presses, etc.)."""
        return self._ws_url("subscribe/events")

    def ws_connect(self, url: str) -> Any:
        """Open a websocket to ``url`` using the configured session and auth."""
        return self._session.ws_connect(
            url,
            headers=self._headers,
            heartbeat=WS_HEARTBEAT,
        )

    async def _get(self, path: str) -> Any:
        url = self._base + path
        try:
            async with self._session.get(
                url,
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as resp:
                if resp.status in (401, 403):
                    raise UnifiProtectAuthError(
                        f"Authentication failed (HTTP {resp.status})", resp.status
                    )
                if not 200 <= resp.status < 300:
                    body = await resp.text()
                    raise UnifiProtectApiError(
                        f"GET {path} failed: HTTP {resp.status}: {body[:200]}",
                        resp.status,
                    )
                if resp.status == 204:
                    return None
                return await resp.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise UnifiProtectApiError(f"GET {path} failed: {err}") from err

    async def async_get_meta(self) -> dict[str, Any]:
        """GET /meta/info. Confirms connectivity and returns the app version."""
        data = await self._get("meta/info")
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _unwrap(result: Any) -> list[dict[str, Any]]:
        """Accept either a raw array or one wrapped under ``data``."""
        if isinstance(result, list):
            return result
        if isinstance(result, dict) and isinstance(result.get("data"), list):
            return result["data"]
        return []

    async def async_get_sensors(self) -> list[dict[str, Any]]:
        """GET /sensors. The full list of UniFi Protect sensors."""
        return self._unwrap(await self._get("sensors"))

    async def async_get_fobs(self) -> list[dict[str, Any]]:
        """GET /fobs. The full list of paired key fobs."""
        return self._unwrap(await self._get("fobs"))

    async def async_get_relays(self) -> list[dict[str, Any]]:
        """GET /relays. UniFi relay (I/O) devices and their outputs."""
        return self._unwrap(await self._get("relays"))

    async def async_activate_relay_output(
        self, relay_id: str, output_id: int, state: str
    ) -> None:
        """Set a relay output on or off.

        POST /relays/{id}/outputs/{outputId}/activate with {"state": ...}.
        """
        await self._post(
            f"relays/{relay_id}/outputs/{output_id}/activate", {"state": state}
        )

    async def _post(self, path: str, json_body: Any | None = None) -> Any:
        url = self._base + path
        try:
            async with self._session.post(
                url,
                headers=self._headers,
                json=json_body,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as resp:
                if resp.status in (401, 403):
                    raise UnifiProtectAuthError(
                        f"Authentication failed (HTTP {resp.status})", resp.status
                    )
                if not 200 <= resp.status < 300:
                    body = await resp.text()
                    raise UnifiProtectApiError(
                        f"POST {path} failed: HTTP {resp.status}: {body[:200]}",
                        resp.status,
                    )
                text = await resp.text()
                return json.loads(text) if text else None
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise UnifiProtectApiError(f"POST {path} failed: {err}") from err
