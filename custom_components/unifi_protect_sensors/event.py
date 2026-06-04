"""Event platform: each fob button press becomes an event entity."""

from __future__ import annotations

from typing import Any

from homeassistant.components.event import (
    EventDeviceClass,
    EventEntity,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DEFAULT_FOB_BUTTONS, FOB_BUTTON_LABELS, SIGNAL_FOB_BUTTON
from .coordinator import UnifiProtectConfigEntry, UnifiProtectCoordinator
from .entity import UnifiProtectFobEntity

EVENT_PRESS = "press"


def _resolve_buttons(fob: dict[str, Any]) -> list[str]:
    """Buttons the API advertises, or the default alarm fob layout."""
    advertised = (fob.get("featureFlags") or {}).get("buttons") or []
    return list(advertised) if advertised else list(DEFAULT_FOB_BUTTONS)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: UnifiProtectConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up fob button event entities and follow newly discovered fobs."""
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def _discover() -> None:
        new: list[UnifiProtectFobButton] = []
        for mac, fob in coordinator.fobs.items():
            for button in _resolve_buttons(fob):
                unique_id = f"{mac}_button_{button}"
                if unique_id in known:
                    continue
                known.add(unique_id)
                new.append(UnifiProtectFobButton(coordinator, mac, button))
        if new:
            async_add_entities(new)

    _discover()
    entry.async_on_unload(coordinator.async_add_listener(_discover))


class UnifiProtectFobButton(UnifiProtectFobEntity, EventEntity):
    """A single button on a UniFi Protect fob."""

    _attr_device_class = EventDeviceClass.BUTTON
    _attr_event_types = [EVENT_PRESS]

    def __init__(
        self,
        coordinator: UnifiProtectCoordinator,
        mac: str,
        button: str,
    ) -> None:
        """Initialise the entity for one button."""
        super().__init__(coordinator, mac)
        self._button = button
        self._attr_unique_id = f"{mac}_button_{button}"
        self._attr_name = FOB_BUTTON_LABELS.get(button, button)

    async def async_added_to_hass(self) -> None:
        """Subscribe to button press dispatches for our fob."""
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                SIGNAL_FOB_BUTTON.format(self.coordinator.config_entry.entry_id),
                self._handle_press,
            )
        )

    @callback
    def _handle_press(self, mac: str | None, button: str) -> None:
        """Fire when a matching press arrives.

        ``mac`` is None when the console reported the press against the alarm
        hub rather than the fob, in which case every fob advertising the button
        fires (this matches the single fob case exactly).
        """
        if button != self._button:
            return
        if mac is not None and mac != self._mac:
            return
        self._trigger_event(EVENT_PRESS)
        self.async_write_ha_state()
