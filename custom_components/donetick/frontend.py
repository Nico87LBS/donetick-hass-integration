"""Serve and automatically load the bundled Donetick dashboard card."""
import asyncio
from hashlib import sha256
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

CARD_URL = "/donetick/donetick-user-todo-card.js"
CARD_FILE = Path(__file__).parent / "frontend" / "donetick-user-todo-card.js"
FAMILY_CARD_URL = "/donetick/donetick-family-card.js"
FAMILY_CARD_FILE = Path(__file__).parent / "frontend" / "donetick-family-card.js"
CARDS = ((CARD_URL, CARD_FILE), (FAMILY_CARD_URL, FAMILY_CARD_FILE))
DATA_FRONTEND = "donetick_frontend"


async def async_setup_frontend(hass: HomeAssistant) -> None:
    """Register once per HA process, including concurrent entries and reloads."""
    state = hass.data.setdefault(DATA_FRONTEND, {"lock": asyncio.Lock()})
    async with state["lock"]:
        if state.get("registered"):
            return
        # File IO runs outside the event loop. A content hash invalidates browser
        # caches whenever HACS installs a changed card, without a second version.
        versions = []
        for url, path in CARDS:
            content = await hass.async_add_executor_job(path.read_bytes)
            versions.append((url, sha256(content).hexdigest()[:12]))
        await hass.http.async_register_static_paths(
            [StaticPathConfig(url, str(path), False) for url, path in CARDS]
        )
        for url, version in versions:
            add_extra_js_url(hass, f"{url}?v={version}")
        state["registered"] = True
