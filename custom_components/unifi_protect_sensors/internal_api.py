"""Thin read-only client for the internal UniFi Protect API (beta).

The Integration API (the ``X-API-KEY`` surface the rest of this integration is
built on) does not expose air-quality readings for the UP Air Quality (UAQ)
monitor. Those values live only in the internal ``/proxy/protect/api`` surface
used by the official apps, which authenticates with a UniFi-OS local account
(session cookie) rather than an API key.

This client is deliberately minimal and read only: log in, GET one sensor, and
re-login once if the session has expired. The internal API is undocumented and
can change shape across Protect firmware, so callers treat every failure here as
"beta data unavailable" and never let it affect the API-key data path.
"""

from __future__ import annotations

import logging
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)

LOGIN_PATH = "/api/auth/login"
INTERNAL_API_PATH = "/proxy/protect/api/"
REQUEST_TIMEOUT = 15


class UnifiProtectLocalError(Exception):
    """A transport or non-2xx failure talking to the internal API."""


class UnifiProtectLocalAuthError(UnifiProtectLocalError):
    """The local account was rejected (bad credentials, or 2FA required)."""


class UnifiProtectInternalClient:
    """Session-cookie access to one console's internal Protect API."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        username: str,
        password: str,
    ) -> None:
        """Store credentials. ``session`` must own an unsafe cookie jar so the
        session cookie is retained for IP-address hosts."""
        host = host.strip().rstrip("/")
        if "://" not in host:
            host = "https://" + host
        self._session = session
        self._base = host
        self._username = username
        self._password = password
        self._logged_in = False

    async def async_login(self) -> None:
        """Authenticate and store the session cookie in the jar."""
        url = self._base + LOGIN_PATH
        try:
            async with self._session.post(
                url,
                json={
                    "username": self._username,
                    "password": self._password,
                    "rememberMe": True,
                },
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as resp:
                if resp.status in (401, 403, 499):
                    raise UnifiProtectLocalAuthError(
                        f"Local account login rejected (HTTP {resp.status}). "
                        "Check the username/password and that the account has "
                        "no 2FA."
                    )
                if not 200 <= resp.status < 300:
                    body = await resp.text()
                    raise UnifiProtectLocalError(
                        f"Login failed: HTTP {resp.status}: {body[:200]}"
                    )
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise UnifiProtectLocalError(f"Login transport error: {err}") from err
        self._logged_in = True

    async def async_get_sensor(self, sensor_id: str) -> dict[str, Any]:
        """GET /sensors/{id} from the internal API (includes ``airQuality``)."""
        data = await self._get(f"sensors/{sensor_id}")
        return data if isinstance(data, dict) else {}

    async def async_close(self) -> None:
        """Detach the private session without closing HA's shared connector."""
        self._session.detach()

    async def _get(self, path: str, _retried: bool = False) -> Any:
        if not self._logged_in:
            await self.async_login()
        url = self._base + INTERNAL_API_PATH + path
        try:
            async with self._session.get(
                url,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as resp:
                if resp.status in (401, 403):
                    # Session likely expired; re-login once and retry.
                    self._logged_in = False
                    if not _retried:
                        return await self._get(path, _retried=True)
                    raise UnifiProtectLocalAuthError(
                        f"Unauthorized after re-login (HTTP {resp.status})"
                    )
                if not 200 <= resp.status < 300:
                    body = await resp.text()
                    raise UnifiProtectLocalError(
                        f"GET {path} failed: HTTP {resp.status}: {body[:200]}"
                    )
                return await resp.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise UnifiProtectLocalError(f"GET {path} failed: {err}") from err
