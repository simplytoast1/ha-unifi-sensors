"""Config and options flow for UniFi Protect Sensors."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import UnifiProtectApiClient, UnifiProtectApiError, UnifiProtectAuthError
from .const import (
    CONF_API_KEY,
    CONF_HOST,
    CONF_SCAN_INTERVAL,
    CONF_VERIFY_SSL,
    DEFAULT_NAME,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_VERIFY_SSL,
    DOMAIN,
    MAX_SCAN_INTERVAL,
    MIN_SCAN_INTERVAL,
)
from .coordinator import UnifiProtectConfigEntry

_LOGGER = logging.getLogger(__name__)


def _unique_id_from_host(host: str) -> str:
    """Derive a stable unique id (host without scheme) to dedupe consoles."""
    parts = urlsplit(host if "://" in host else f"https://{host}")
    return (parts.netloc or parts.path).strip("/").lower()


async def _async_validate(hass, host: str, api_key: str, verify_ssl: bool) -> None:
    """Raise if the console is unreachable or rejects the API key."""
    session = async_get_clientsession(hass, verify_ssl=verify_ssl)
    client = UnifiProtectApiClient(session, host, api_key)
    await client.async_get_meta()


class UnifiProtectConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial setup and reauth."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Collect the console URL and API key."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                await _async_validate(
                    self.hass,
                    user_input[CONF_HOST],
                    user_input[CONF_API_KEY],
                    user_input[CONF_VERIFY_SSL],
                )
            except UnifiProtectAuthError:
                errors["base"] = "invalid_auth"
            except UnifiProtectApiError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error validating UniFi console")
                errors["base"] = "unknown"
            else:
                await self.async_set_unique_id(
                    _unique_id_from_host(user_input[CONF_HOST])
                )
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title=DEFAULT_NAME, data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST): str,
                    vol.Required(CONF_API_KEY): str,
                    vol.Optional(
                        CONF_VERIFY_SSL, default=DEFAULT_VERIFY_SSL
                    ): bool,
                }
            ),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Start reauth when the API key stops working."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Prompt for a fresh API key and update the entry."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                await _async_validate(
                    self.hass,
                    entry.data[CONF_HOST],
                    user_input[CONF_API_KEY],
                    entry.data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL),
                )
            except UnifiProtectAuthError:
                errors["base"] = "invalid_auth"
            except UnifiProtectApiError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error during reauth")
                errors["base"] = "unknown"
            else:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_API_KEY: user_input[CONF_API_KEY]}
                )

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_API_KEY): str}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: UnifiProtectConfigEntry,
    ) -> UnifiProtectOptionsFlow:
        """Return the options flow handler."""
        return UnifiProtectOptionsFlow()


class UnifiProtectOptionsFlow(OptionsFlow):
    """Expose the polling fallback interval."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage the scan interval option."""
        if user_input is not None:
            return self.async_create_entry(data=user_input)

        current = self.config_entry.options.get(
            CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL
        )
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        CONF_SCAN_INTERVAL, default=current
                    ): vol.All(
                        vol.Coerce(int),
                        vol.Range(min=MIN_SCAN_INTERVAL, max=MAX_SCAN_INTERVAL),
                    ),
                }
            ),
        )
