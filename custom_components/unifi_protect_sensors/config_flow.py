"""Config and options flow for UniFi Protect Sensors."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import (
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import (
    async_create_clientsession,
    async_get_clientsession,
)
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .api import UnifiProtectApiClient, UnifiProtectApiError, UnifiProtectAuthError
from .const import (
    CONF_API_KEY,
    CONF_HOST,
    CONF_LOCAL_ENABLED,
    CONF_LOCAL_PASSWORD,
    CONF_LOCAL_USERNAME,
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
from .internal_api import (
    UnifiProtectInternalClient,
    UnifiProtectLocalAuthError,
    UnifiProtectLocalError,
)

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


async def _async_validate_local(
    hass, host: str, username: str, password: str, verify_ssl: bool
) -> None:
    """Raise if the local account cannot log into the internal API."""
    session = async_create_clientsession(
        hass, verify_ssl=verify_ssl, cookie_jar=aiohttp.CookieJar(unsafe=True)
    )
    try:
        client = UnifiProtectInternalClient(session, host, username, password)
        await client.async_login()
    finally:
        await session.close()


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
    """Expose the polling interval and the beta local-account option."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage the scan interval and the local-account (beta) settings."""
        errors: dict[str, str] = {}
        if user_input is not None:
            if user_input.get(CONF_LOCAL_ENABLED):
                username = user_input.get(CONF_LOCAL_USERNAME)
                password = user_input.get(CONF_LOCAL_PASSWORD)
                if not username or not password:
                    errors["base"] = "local_credentials_required"
                else:
                    verify_ssl = self.config_entry.data.get(
                        CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL
                    )
                    try:
                        await _async_validate_local(
                            self.hass,
                            self.config_entry.data[CONF_HOST],
                            username,
                            password,
                            verify_ssl,
                        )
                    except UnifiProtectLocalAuthError:
                        errors["base"] = "invalid_local_auth"
                    except UnifiProtectLocalError:
                        errors["base"] = "cannot_connect"
            if not errors:
                return self.async_create_entry(data=user_input)

        options = self.config_entry.options

        def default(key: str, fallback: Any) -> Any:
            if user_input is not None and key in user_input:
                return user_input[key]
            return options.get(key, fallback)

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        CONF_SCAN_INTERVAL,
                        default=default(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
                    ): vol.All(
                        vol.Coerce(int),
                        vol.Range(min=MIN_SCAN_INTERVAL, max=MAX_SCAN_INTERVAL),
                    ),
                    vol.Optional(
                        CONF_LOCAL_ENABLED,
                        default=default(CONF_LOCAL_ENABLED, False),
                    ): bool,
                    vol.Optional(
                        CONF_LOCAL_USERNAME,
                        default=default(CONF_LOCAL_USERNAME, ""),
                    ): str,
                    vol.Optional(
                        CONF_LOCAL_PASSWORD,
                        default=default(CONF_LOCAL_PASSWORD, ""),
                    ): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.PASSWORD)
                    ),
                }
            ),
            errors=errors,
        )
