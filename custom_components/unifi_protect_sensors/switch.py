"""Switch platform: UniFi relay outputs."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchDeviceClass, SwitchEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import UnifiProtectConfigEntry, UnifiProtectCoordinator
from .entity import UnifiProtectRelayEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: UnifiProtectConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up relay output switches and follow newly discovered relays."""
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def _discover() -> None:
        new: list[UnifiProtectRelayOutput] = []
        for mac, relay in coordinator.relays.items():
            for output in relay.get("outputs") or []:
                output_id = output.get("id")
                if output_id is None:
                    continue
                unique_id = f"{mac}_output_{output_id}"
                if unique_id in known:
                    continue
                known.add(unique_id)
                new.append(
                    UnifiProtectRelayOutput(coordinator, mac, output_id, output)
                )
        if new:
            async_add_entities(new)

    _discover()
    entry.async_on_unload(coordinator.async_add_listener(_discover))


class UnifiProtectRelayOutput(UnifiProtectRelayEntity, SwitchEntity):
    """One controllable output channel on a UniFi relay."""

    _attr_device_class = SwitchDeviceClass.SWITCH

    def __init__(
        self,
        coordinator: UnifiProtectCoordinator,
        mac: str,
        output_id: int,
        output: dict[str, Any],
    ) -> None:
        """Initialise the switch for one relay output."""
        super().__init__(coordinator, mac)
        self._output_id = output_id
        self._attr_unique_id = f"{mac}_output_{output_id}"
        self._attr_name = output.get("name") or f"Output {output_id + 1}"

    def _output(self) -> dict[str, Any] | None:
        for output in (self._device or {}).get("outputs") or []:
            if output.get("id") == self._output_id:
                return output
        return None

    @property
    def available(self) -> bool:
        """Available while the relay is connected and the output exists."""
        device = self._device
        return (
            self.coordinator.last_update_success
            and device is not None
            and device.get("state") == "CONNECTED"
            and self._output() is not None
        )

    @property
    def is_on(self) -> bool | None:
        """Return whether the output is energised."""
        output = self._output()
        if output is None:
            return None
        return output.get("state") == "on"

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Energise the output."""
        await self._set_state("on")

    async def async_turn_off(self, **kwargs: Any) -> None:
        """De-energise the output."""
        await self._set_state("off")

    async def _set_state(self, state: str) -> None:
        relay = self._device
        if relay is None or not relay.get("id"):
            return
        await self.coordinator.client.async_activate_relay_output(
            relay["id"], self._output_id, state
        )
        # Optimistically reflect the new state, then confirm on next refresh.
        output = self._output()
        if output is not None:
            output["state"] = state
        self.async_write_ha_state()
        await self.coordinator.async_request_refresh()
