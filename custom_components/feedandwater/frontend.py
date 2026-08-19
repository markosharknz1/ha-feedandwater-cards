"""Serve the bundled Lovelace card and register it as a dashboard resource.

The card ships inside the integration (``lovelace/feedandwater-card.js``)
so a HACS install delivers it too — HACS only copies ``custom_components/``,
so nothing can live in ``config/www``. Registering here means
``type: custom:feedandwater-card`` resolves with no manual
"Settings > Dashboards > Resources" step. Pattern lifted from the
maintainer's jebao_local integration (panel.py there), including the
version query for browser cache-busting and the YAML-dashboard fallback.
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

CARD_URL = "/feedandwater/feedandwater-card.js"
CARD_VERSION = "0.5.0"  # bump to bust the browser cache when the card changes

_CARD_REGISTERED_KEY = "feedandwater_card_registered"


async def async_register_card(hass: HomeAssistant) -> None:
    """Serve the bundled card and add it to dashboards (idempotent)."""
    if hass.data.get(_CARD_REGISTERED_KEY):
        return

    source = Path(__file__).parent / "lovelace" / "feedandwater-card.js"
    if not source.is_file():
        _LOGGER.warning("Bundled card missing at %s; skipping", source)
        return

    try:
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, str(source), True)]
        )
    except ImportError:  # Home Assistant < 2024.7
        hass.http.register_static_path(CARD_URL, str(source), True)
    except RuntimeError:
        pass  # already registered (reload)

    hass.data[_CARD_REGISTERED_KEY] = True

    from homeassistant.helpers.start import async_at_started

    async def _add_card_resource(_event=None) -> None:
        if await _register_lovelace_resource(hass):
            _LOGGER.info("Reef Feed & Water card registered as a Lovelace resource")
            return
        # YAML-mode dashboards: no storage resource collection — inject
        # globally instead, and document the manual fallback.
        try:
            from homeassistant.components import frontend

            frontend.add_extra_js_url(hass, f"{CARD_URL}?v={CARD_VERSION}")
            _LOGGER.info("Reef Feed & Water card injected via extra_js_url (YAML mode)")
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning(
                "Could not auto-load the Reef Feed & Water card (%s). Add it "
                "by hand: Settings > Dashboards > Resources > Add > URL %s , "
                "type JavaScript module.",
                err,
                f"{CARD_URL}?v={CARD_VERSION}",
            )

    async_at_started(hass, _add_card_resource)


async def _register_lovelace_resource(hass: HomeAssistant) -> bool:
    """Add (or version-bump) the card in the Lovelace resource collection.

    Returns False when the storage-backed collection isn't available
    (YAML-mode dashboards). Guarded because ``hass.data['lovelace']`` has
    changed shape across HA versions.
    """
    url = f"{CARD_URL}?v={CARD_VERSION}"
    try:
        lovelace = hass.data.get("lovelace")
        resources = getattr(lovelace, "resources", None)
        if resources is None and isinstance(lovelace, dict):
            resources = lovelace.get("resources")
        if resources is None or not hasattr(resources, "async_create_item"):
            return False

        if hasattr(resources, "loaded") and not resources.loaded:
            await resources.async_load()
            resources.loaded = True

        for item in resources.async_items():
            if str(item.get("url", "")).split("?")[0] == CARD_URL:
                if item.get("url") != url and item.get("id"):
                    await resources.async_update_item(item["id"], {"url": url})
                return True

        await resources.async_create_item({"res_type": "module", "url": url})
        return True
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Lovelace resource registration skipped: %s", err)
        return False
