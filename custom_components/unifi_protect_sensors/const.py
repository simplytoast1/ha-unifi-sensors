"""Constants for the UniFi Protect Sensors integration."""

from __future__ import annotations

from homeassistant.const import Platform

DOMAIN = "unifi_protect_sensors"
DEFAULT_NAME = "UniFi Protect Sensors"
MANUFACTURER = "Ubiquiti"

# Config entry keys.
CONF_HOST = "host"
CONF_API_KEY = "api_key"
CONF_VERIFY_SSL = "verify_ssl"
CONF_SCAN_INTERVAL = "scan_interval"

# Optional "beta" local-account mode. The Integration API (the X-API-KEY surface
# this integration is built on) does not expose the UP Air Quality monitor's
# readings; those live only in the internal Protect API, which needs a UniFi-OS
# local account (session cookie). When enabled, a separate, isolated coordinator
# polls that API for air-quality sensors. Undocumented and firmware-fragile.
CONF_LOCAL_ENABLED = "local_enabled"
CONF_LOCAL_USERNAME = "local_username"
CONF_LOCAL_PASSWORD = "local_password"

DEFAULT_VERIFY_SSL = False
# REST poll cadence. This integration is push first (it subscribes to the
# console websockets), so polling is only a fallback for when the websocket is
# down plus a periodic safety net to reconcile deletions.
DEFAULT_SCAN_INTERVAL = 60
MIN_SCAN_INTERVAL = 5
MAX_SCAN_INTERVAL = 3600

# Poll cadence for the internal air-quality API. The device samples every ~15s;
# 30s keeps Home Assistant close without hammering the rate-limited internal API.
AIR_QUALITY_SCAN_INTERVAL = 30

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.EVENT,
    Platform.SENSOR,
    Platform.SWITCH,
]

# Hold windows (seconds) for momentary, timestamp-only events. The Integration
# API stamps an "*At" time when an event fires but never sends an explicit
# "ended" signal, so we keep the entity on for this long after the timestamp
# and then auto clear it.
MOTION_HOLD = 5
ALARM_HOLD = 5
LEAK_HOLD = 60
GLASS_HOLD = 5

# Every button a fob may advertise (the OpenAPI enum).
FOB_BUTTONS = [
    "function",
    "alarmHubButton",
    "arm",
    "disarm",
    "night",
    "panic",
    "left",
    "right",
    "input1",
    "input2",
]
# Fallback button set used when the API reports featureFlags.buttons empty or
# missing (observed on the USL Fob, Protect 7.1.60).
DEFAULT_FOB_BUTTONS = ["arm", "disarm", "night", "panic", "left", "right"]

# Pretty labels for the bare enum button names.
FOB_BUTTON_LABELS = {
    "function": "Function",
    "alarmHubButton": "Hub Button",
    "arm": "Arm",
    "disarm": "Disarm",
    "night": "Night",
    "panic": "Panic",
    "left": "Left",
    "right": "Right",
    "input1": "Input 1",
    "input2": "Input 2",
}

# Dispatcher signal carrying fob button presses. Formatted with the config
# entry id so multiple consoles do not cross talk.
SIGNAL_FOB_BUTTON = f"{DOMAIN}_fob_button_{{}}"
