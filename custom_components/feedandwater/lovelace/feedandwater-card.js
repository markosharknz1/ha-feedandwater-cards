/*
 * Reef Feed & Water card
 * ----------------------
 * Native Lovelace card for the feedandwater integration. Discovers tanks
 * from HA's entity registry (platform === "feedandwater"), so the common
 * case needs zero configuration:
 *
 *   type: custom:feedandwater-card          # every tank, one compact row each
 *
 * Optional config:
 *   tanks: [reef, frag]     # limit to specific tank slugs
 *   title: Fish Room        # optional heading above the tank rows
 *
 * Design contract (deliberate): each tank renders as ONE compact block —
 * a status line plus contextual action chips — so a shop wall with 5-10
 * tanks stays scannable. Settings sliders live in a collapsed "settings"
 * drawer per tank, not on the main face of the card.
 *
 * Writes go through HA's own button/number/text services as the logged-in
 * user. Live countdowns tick locally from the stage sensors' *_at
 * attributes (ISO timestamps), so no polling is involved.
 *
 * Has a visual editor (FeedAndWaterCardEditor below): tank checkboxes +
 * title field instead of hand-typing YAML.
 */

const SENSOR_SUFFIXES = [
  "feed_stage",
  "water_change_stage",
  "last_water_change",
  "device_off_durations",
  "light_stage",
  "pump_speeds",
  "last_done",
];
const BUTTON_SUFFIXES = [
  "start_feed",
  "feed_until_stop",
  "stop_feed",
  "start_water_change",
  "resume_water_change",
  "log_water_change",
  "lights_on",
  "lights_off",
  "done",
];
const NUMBER_SUFFIXES = [
  "feed_duration",
  "return_pump_feed_speed",
  "skimmer_extra_off",
  "wavemaker_restart_delay",
  "skimmer_restart_delay",
  "power_loss_delay",
  "last_water_change_volume",
  "light_timer",
];
const TEXT_SUFFIXES = ["tracked_devices"];

const ALL_SUFFIXES = [
  ...SENSOR_SUFFIXES.map((s) => ["sensor", s]),
  ...BUTTON_SUFFIXES.map((s) => ["button", s]),
  ...NUMBER_SUFFIXES.map((s) => ["number", s]),
  ...TEXT_SUFFIXES.map((s) => ["text", s]),
];

// Sliders shown in the per-tank settings drawer, in order.
const SETTINGS_SLIDERS = [
  ["feed_duration", "Feed duration", "min"],
  ["return_pump_feed_speed", "Return pump feed speed", "%"],
  ["skimmer_extra_off", "Skimmer extra off", "min"],
  ["wavemaker_restart_delay", "Wavemaker restart delay", "min"],
  ["skimmer_restart_delay", "Skimmer restart delay", "min"],
  ["light_timer", "Light timer (0 = until off)", "min"],
];

// Shared by the card and its editor so "which tanks exist" is answered
// identically in both places.
function discoverTanks(hass, slugFilter) {
  if (!hass) return [];
  const want = slugFilter ? new Set(slugFilter.map((s) => String(s))) : null;
  const tanks = new Map(); // slug -> {slug, name, entities: {suffix: entity_id}}

  const add = (entityId, deviceName) => {
    const dot = entityId.indexOf(".");
    const domain = entityId.slice(0, dot);
    const objectId = entityId.slice(dot + 1);
    for (const [sufDomain, suffix] of ALL_SUFFIXES) {
      if (domain !== sufDomain) continue;
      if (!objectId.endsWith("_" + suffix)) continue;
      const slug = objectId.slice(0, objectId.length - suffix.length - 1);
      if (!slug || (want && !want.has(slug))) return;
      if (!tanks.has(slug)) tanks.set(slug, { slug, name: null, entities: {} });
      const tank = tanks.get(slug);
      tank.entities[suffix] = entityId;
      if (deviceName && !tank.name) tank.name = deviceName;
      return;
    }
  };

  const registry = hass.entities;
  if (registry && Object.keys(registry).length) {
    for (const [entityId, entry] of Object.entries(registry)) {
      if (entry.platform !== "feedandwater") continue;
      const device = entry.device_id && hass.devices ? hass.devices[entry.device_id] : null;
      add(entityId, device ? device.name_by_user || device.name : null);
    }
  } else {
    // Ancient frontend without the display registry: pattern-match states.
    for (const entityId of Object.keys(hass.states)) add(entityId, null);
  }

  // An entry must have its own start_feed button (full tank), lights_on
  // button (light timer), done button (maintenance task), or pump_speeds
  // sensor (standalone Speed card entry) — filters out lookalike entities
  // from the manual-YAML flavor of this pack.
  const result = [...tanks.values()].filter(
    (t) =>
      t.entities.start_feed ||
      t.entities.lights_on ||
      t.entities.done ||
      t.entities.pump_speeds
  );
  for (const t of result) if (!t.name) t.name = t.slug;
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

const fmtRemaining = (iso) => {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "now";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
};

const unresponsiveNote = (hass, sensorState) => {
  const ids = (sensorState && sensorState.attributes.unresponsive) || [];
  if (!ids.length) return "";
  const names = ids.map((id) => {
    const st = hass.states[id];
    return (st && st.attributes.friendly_name) || id;
  });
  return `<div class="warn">⚠ No response: ${names.join(", ")}</div>`;
};

const fmtOffMinutes = (minutes) => {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  return `${Math.round(minutes)} min`;
};

class FeedAndWaterCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("feedandwater-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    this._open = this._open || {}; // slug -> settings drawer open?
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    this._syncTicker();
  }

  getCardSize() {
    const tanks = discoverTanks(this._hass, this._config && this._config.tanks);
    return Math.max(2, tanks.length * 2);
  }

  disconnectedCallback() {
    this._stopTicker();
  }

  connectedCallback() {
    this._syncTicker();
  }

  _syncTicker() {
    // Tick once a second only while some countdown is visible.
    const tanks = discoverTanks(this._hass, this._config && this._config.tanks);
    const active = tanks.some((t) => {
      const feed = this._state(t, "feed_stage");
      const wc = this._state(t, "water_change_stage");
      const light = this._state(t, "light_stage");
      return (
        (feed && feed.state !== "idle") ||
        (wc && wc.state !== "idle") ||
        (light && light.state === "on_timed")
      );
    });
    if (active && !this._timer) {
      this._timer = setInterval(() => this._render(), 1000);
    } else if (!active) {
      this._stopTicker();
    }
  }

  _stopTicker() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _state(tank, suffix) {
    const id = tank.entities[suffix];
    return id && this._hass ? this._hass.states[id] : null;
  }

  _press(tank, suffix) {
    const id = tank.entities[suffix];
    if (id) this._hass.callService("button", "press", { entity_id: id });
  }

  _setNumber(tank, suffix, value) {
    const id = tank.entities[suffix];
    if (id)
      this._hass.callService("number", "set_value", {
        entity_id: id,
        value: Number(value),
      });
  }

  _statusFor(tank) {
    // One line per tank; water-change stages outrank feed stages because a
    // paused tank is the more urgent thing to see.
    const wc = this._state(tank, "water_change_stage");
    const feed = this._state(tank, "feed_stage");
    if (wc && wc.state === "paused")
      return { dot: "blue", text: "Water change — tap Resume when done" };
    if (wc && wc.state === "restarting_wavemakers")
      return {
        dot: "orange",
        text: `Resuming — wavemakers in ${fmtRemaining(wc.attributes.wavemakers_at) || "…"}`,
      };
    if (wc && wc.state === "restarting_skimmer")
      return {
        dot: "orange",
        text: `Resuming — skimmer in ${fmtRemaining(wc.attributes.skimmer_at) || "…"}`,
      };
    if (feed && feed.state === "feeding")
      return {
        dot: "blue",
        text: `Feeding — wavemakers in ${fmtRemaining(feed.attributes.wavemakers_at) || "…"}`,
      };
    if (feed && feed.state === "settling")
      return {
        dot: "orange",
        text: `Settling — skimmer in ${fmtRemaining(feed.attributes.skimmer_at) || "…"}`,
      };
    return { dot: "green", text: "Idle" };
  }

  _chipsFor(tank) {
    const wc = this._state(tank, "water_change_stage");
    const feed = this._state(tank, "feed_stage");
    const wcState = wc ? wc.state : "idle";
    const feedState = feed ? feed.state : "idle";
    const chips = [];

    if (tank.entities.start_feed) {
      if (feedState !== "idle") {
        chips.push({ label: "Stop Feeding", icon: "■", cls: "stop", act: "stop_feed" });
      } else if (wcState === "idle") {
        chips.push({ label: "Feed", icon: "🍤", cls: "go", act: "start_feed" });
        chips.push({ label: "Until I Stop", icon: "∞", cls: "alt", act: "feed_until_stop" });
      }
    }

    if (tank.entities.start_water_change) {
      if (wcState === "paused") {
        chips.push({ label: "Resume", icon: "▶", cls: "go", act: "resume_water_change" });
      } else if (wcState === "idle" && feedState === "idle") {
        chips.push({ label: "Water Change", icon: "💧", cls: "alt", act: "start_water_change" });
      }
    }
    // While a staged restart runs there is deliberately nothing to tap.

    // Light timer chip (only for tanks with lights configured)
    const light = this._state(tank, "light_stage");
    if (light) {
      if (light.state === "off") {
        chips.push({ label: "Lights On", icon: "💡", cls: "alt", act: "lights_on" });
      } else {
        const remaining =
          light.state === "on_timed" ? fmtRemaining(light.attributes.off_at) : null;
        chips.push({
          label: "Lights Off" + (remaining ? " · " + remaining : ""),
          icon: "💡",
          cls: "alt",
          act: "lights_off",
        });
      }
    }
    return chips;
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    // Tanks and light timers belong on the main card; maintenance tasks
    // have their own card.
    const tanks = discoverTanks(hass, this._config.tanks).filter(
      (t) => t.entities.start_feed || t.entities.lights_on
    );

    const style = `
      <style>
        ha-card { padding: 12px 16px; height: 100%; box-sizing: border-box; }
        .heading { font-size: 1.1em; font-weight: 500; margin-bottom: 8px; }
        .tank { padding: 8px 0; }
        .tank + .tank { border-top: 1px solid var(--divider-color); }
        .row { display: flex; align-items: center; gap: 8px; }
        .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
        .dot.green { background: var(--success-color, #4caf50); }
        .dot.blue { background: var(--info-color, #2196f3); }
        .dot.orange { background: var(--warning-color, #ff9800); }
        .name { font-weight: 500; }
        .status { color: var(--secondary-text-color); font-size: 0.92em;
                  flex: 1; text-align: right; }
        .speeds { color: var(--secondary-text-color); font-size: 0.85em;
                  margin: 4px 0 0 18px; }
        .speeds b { color: var(--primary-text-color); font-weight: 500; }
        .warn { color: var(--error-color, #f44336); font-size: 0.85em;
                margin: 4px 0 0 18px; }
        .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .chip { display: inline-flex; align-items: center; gap: 6px;
                border-radius: 16px; padding: 6px 16px; cursor: pointer;
                font: inherit; font-size: 0.92em; border: 1px solid var(--divider-color);
                background: var(--secondary-background-color);
                color: var(--primary-text-color); }
        .chip.go { background: var(--primary-color); color: var(--text-primary-color, #fff);
                   border-color: var(--primary-color); }
        .chip.stop { background: var(--error-color, #f44336); color: #fff;
                     border-color: var(--error-color, #f44336); }
        .chip:active { opacity: 0.8; }
        .gear { margin-left: auto; background: none; border: none; cursor: pointer;
                color: var(--secondary-text-color); font: inherit; font-size: 0.85em;
                padding: 5px 6px; }
        .drawer { margin-top: 8px; padding: 8px 12px; border-radius: 8px;
                  background: var(--secondary-background-color); }
        .slider-row { display: flex; align-items: center; gap: 10px;
                      padding: 4px 0; font-size: 0.9em; }
        .slider-row label { flex: 0 0 11.5em; color: var(--secondary-text-color); }
        .slider-row input[type=range] { flex: 1; }
        .slider-row .val { flex: 0 0 4.5em; text-align: right; }
        /* Inline feed-timer slider on the tank row (drawer sliders keep
           their wide fixed labels) */
        .tank > .slider-row { margin-top: 8px; }
        .tank > .slider-row label { flex: 0 0 auto; }
        .tank > .slider-row .val { flex: 0 0 5.5em; }
        .drawer-foot { display: flex; align-items: center; justify-content: space-between;
                       margin-top: 6px; font-size: 0.88em;
                       color: var(--secondary-text-color); }
        .link { background: none; border: none; cursor: pointer; color: var(--primary-color);
                font: inherit; font-size: 1em; padding: 0; }
        .empty { color: var(--secondary-text-color); padding: 8px 0; }
      </style>`;

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else if (!tanks.length) {
      body = `<div class="empty">No Reef Feed &amp; Water tanks found. Add one via
        Settings &gt; Devices &amp; Services &gt; Add Integration.</div>`;
    } else {
      body = tanks
        .map((tank) => {
          const status = this._statusFor(tank);
          const chips = this._chipsFor(tank)
            .map(
              (c, i) =>
                `<button class="chip ${c.cls}" data-slug="${tank.slug}" data-act="${c.act}">
                   <span>${c.icon}</span>${c.label}</button>`
            )
            .join("");
          const open = this._open[tank.slug];
          let drawer = "";
          if (open) {
            const sliders = SETTINGS_SLIDERS.filter(([k]) => tank.entities[k])
              .map(([key, label, unit]) => {
                const st = this._state(tank, key);
                if (!st) return "";
                const a = st.attributes;
                return `<div class="slider-row">
                    <label>${label}</label>
                    <input type="range" min="${a.min}" max="${a.max}" step="${a.step}"
                      value="${st.state}" data-slug="${tank.slug}" data-num="${key}">
                    <span class="val">${Number(st.state)} ${unit}</span>
                  </div>`;
              })
              .join("");
            let foot = "";
            if (tank.entities.log_water_change) {
              const last = this._state(tank, "last_water_change");
              const lastText =
                last && last.state && !["unknown", "unavailable"].includes(last.state)
                  ? new Date(last.state).toLocaleString()
                  : "never logged";
              foot = `<div class="drawer-foot">
                  <span>Last water change: ${lastText}</span>
                  <button class="link" data-slug="${tank.slug}" data-act="log_water_change">
                    Log water change now</button>
                </div>`;
            }
            drawer = `<div class="drawer">
                ${sliders}
                ${foot}
              </div>`;
          }
          // At-a-glance pump speeds line (only when the tank monitors any)
          let speedsLine = "";
          const speedsSensor = this._state(tank, "pump_speeds");
          if (speedsSensor && (speedsSensor.attributes.speeds || []).length) {
            const parts = speedsSensor.attributes.speeds.map((s) => {
              const value =
                !s.on ? "off" : s.value === null ? "?" : `${Math.round(s.value)}${s.unit}`;
              return `${s.name} <b>${value}</b>`;
            });
            speedsLine = `<div class="speeds">${parts.join(" · ")}</div>`;
          }
          // Inline feed-timer slider on the row face (same pattern as the
          // Lights card's Timer) — drags set the feed duration used by the
          // next tap of Feed.
          let feedSlider = "";
          const feedDur = this._state(tank, "feed_duration");
          if (feedDur && tank.entities.start_feed) {
            const a = feedDur.attributes;
            feedSlider = `<div class="slider-row">
                <label>Feed timer</label>
                <input type="range" min="${a.min}" max="${a.max}" step="${a.step}"
                  value="${feedDur.state}" data-slug="${tank.slug}" data-num="feed_duration">
                <span class="val">${Number(feedDur.state)} min</span>
              </div>`;
          }
          const warn = unresponsiveNote(
            hass,
            this._state(tank, "feed_stage") || this._state(tank, "light_stage")
          );
          return `<div class="tank">
              <div class="row">
                <span class="dot ${status.dot}"></span>
                <span class="name">${tank.name}</span>
                <span class="status">${status.text}</span>
                <button class="gear" data-slug="${tank.slug}" data-gear="1"
                  title="Tank settings">⚙</button>
              </div>
              ${warn}
              ${speedsLine}
              ${feedSlider}
              <div class="chips">${chips}</div>
              ${drawer}
            </div>`;
        })
        .join("");
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `${style}<ha-card>${heading}${body}</ha-card>`;

    // Wire events (innerHTML re-render keeps this simple and is fine at
    // this scale — a handful of tanks, 1 Hz max).
    this.shadowRoot.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", () => {
        const tank = tanks.find((t) => t.slug === el.dataset.slug);
        if (tank) this._press(tank, el.dataset.act);
      });
    });
    this.shadowRoot.querySelectorAll("[data-gear]").forEach((el) => {
      el.addEventListener("click", () => {
        this._open[el.dataset.slug] = !this._open[el.dataset.slug];
        this._render();
      });
    });
    this.shadowRoot.querySelectorAll("[data-num]").forEach((el) => {
      el.addEventListener("change", () => {
        const tank = tanks.find((t) => t.slug === el.dataset.slug);
        if (tank) this._setNumber(tank, el.dataset.num, el.value);
      });
    });
  }
}

class FeedAndWaterDevicesCard extends HTMLElement {
  /* Device Tracker card: the tracked-devices off-duration table, with the
   * comma-separated entity list editable right on the card. One block per
   * tank; same zero-config discovery + tanks filter as the main card. */

  static getConfigElement() {
    return document.createElement("feedandwater-devices-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 3;
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    // Only tanks that actually have device tracking (not light timers)
    const tanks = discoverTanks(hass, this._config.tanks).filter(
      (t) => t.entities.tracked_devices
    );

    const style = `
      <style>
        ha-card { padding: 12px 16px; height: 100%; box-sizing: border-box; }
        .heading { font-size: 1.1em; font-weight: 500; margin-bottom: 8px; }
        .tank + .tank { border-top: 1px solid var(--divider-color); margin-top: 10px; padding-top: 10px; }
        .name { font-weight: 500; margin-bottom: 6px; }
        .edit { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
        .edit input { flex: 1; padding: 6px 8px; font: inherit; font-size: 0.88em;
          background: var(--secondary-background-color); color: var(--primary-text-color);
          border: 1px solid var(--divider-color); border-radius: 6px; }
        table { width: 100%; border-collapse: collapse; font-size: 0.92em; }
        th { text-align: left; color: var(--secondary-text-color); font-weight: 400;
             padding: 2px 6px; border-bottom: 1px solid var(--divider-color); }
        td { padding: 4px 6px; }
        td.right, th.right { text-align: right; }
        .empty { color: var(--secondary-text-color); font-size: 0.9em; padding: 4px 0; }
      </style>`;

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else if (!tanks.length) {
      body = `<div class="empty">No Reef Feed &amp; Water tanks found.</div>`;
    } else {
      body = tanks
        .map((tank) => {
          const text = this._hassState(tank, "tracked_devices");
          const sensor = this._hassState(tank, "device_off_durations");
          const devices = (sensor && sensor.attributes.devices) || [];
          const rows = devices
            .map(
              (d) => `<tr>
                <td>${d.name}</td>
                <td>${d.state === "off" ? "🔴 Off" : d.state === "on" ? "🟢 On" : d.state}</td>
                <td class="right">${d.state === "off" ? fmtOffMinutes(d.off_minutes) : "—"}</td>
              </tr>`
            )
            .join("");
          const table = devices.length
            ? `<table><tr><th>Device</th><th>Status</th><th class="right">Off for</th></tr>${rows}</table>`
            : `<div class="empty">No devices tracked yet — paste entity IDs above (comma-separated).</div>`;
          const nameRow = tanks.length > 1 ? `<div class="name">${tank.name}</div>` : "";
          return `<div class="tank">
              ${nameRow}
              <div class="edit">
                <input type="text" placeholder="switch.skimmer_plug, fan.wavemaker_1, …"
                  value="${text ? text.state.replace(/"/g, "&quot;") : ""}"
                  data-slug="${tank.slug}">
              </div>
              ${table}
            </div>`;
        })
        .join("");
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `${style}<ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("input[data-slug]").forEach((el) => {
      el.addEventListener("change", () => {
        const tank = tanks.find((t) => t.slug === el.dataset.slug);
        if (tank && tank.entities.tracked_devices) {
          this._hass.callService("text", "set_value", {
            entity_id: tank.entities.tracked_devices,
            value: el.value,
          });
        }
      });
    });
  }

  _hassState(tank, suffix) {
    const id = tank.entities[suffix];
    return id && this._hass ? this._hass.states[id] : null;
  }
}

class FeedAndWaterLightsCard extends HTMLElement {
  /* Lights card: per-tank light control with the duration slider front and
   * center — tap on/off, drag the timer (0 = stay on until turned off),
   * live countdown while a timed session runs. Shows only tanks that have
   * lights configured. */

  static getConfigElement() {
    return document.createElement("feedandwater-lights-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    this._syncTicker();
  }

  getCardSize() {
    return 2;
  }

  disconnectedCallback() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _syncTicker() {
    const tanks = this._lightTanks();
    const active = tanks.some((t) => {
      const s = this._hassState(t, "light_stage");
      return s && s.state === "on_timed";
    });
    if (active && !this._timer) {
      this._timer = setInterval(() => this._render(), 1000);
    } else if (!active && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _lightTanks() {
    return discoverTanks(this._hass, this._config && this._config.tanks).filter(
      (t) => t.entities.light_stage
    );
  }

  _hassState(tank, suffix) {
    const id = tank.entities[suffix];
    return id && this._hass ? this._hass.states[id] : null;
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    const tanks = this._lightTanks();

    const style = `
      <style>
        ha-card { padding: 12px 16px; height: 100%; box-sizing: border-box; }
        .heading { font-size: 1.1em; font-weight: 500; margin-bottom: 8px; }
        .tank + .tank { border-top: 1px solid var(--divider-color); margin-top: 10px; padding-top: 10px; }
        .row { display: flex; align-items: center; gap: 8px; }
        .name { font-weight: 500; }
        .status { color: var(--secondary-text-color); font-size: 0.92em; flex: 1; text-align: right; }
        .slider-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: 0.9em; }
        .slider-row label { flex: none; color: var(--secondary-text-color); }
        .slider-row input[type=range] { flex: 1; }
        .slider-row .val { flex: 0 0 6.5em; text-align: right; }
        .chips { display: flex; gap: 8px; margin-top: 8px; }
        .chip { display: inline-flex; align-items: center; gap: 6px;
                border-radius: 16px; padding: 6px 16px; cursor: pointer;
                font: inherit; font-size: 0.92em; border: 1px solid var(--divider-color);
                background: var(--secondary-background-color);
                color: var(--primary-text-color); }
        .chip.go { background: var(--primary-color); color: var(--text-primary-color, #fff);
                   border-color: var(--primary-color); }
        .warn { color: var(--error-color, #f44336); font-size: 0.85em; margin-top: 4px; }
        .empty { color: var(--secondary-text-color); font-size: 0.9em; padding: 4px 0; }
      </style>`;

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else if (!tanks.length) {
      body = `<div class="empty">No tanks with lights configured — add lights via the
        tank's Configure dialog (Settings &gt; Devices &amp; Services).</div>`;
    } else {
      body = tanks
        .map((tank) => {
          const stage = this._hassState(tank, "light_stage");
          const timer = this._hassState(tank, "light_timer");
          const state = stage ? stage.state : "off";
          let statusText = "Off";
          if (state === "on_timed")
            statusText = `On — off in ${fmtRemaining(stage.attributes.off_at) || "…"}`;
          else if (state === "on") statusText = "On until turned off";
          const chip =
            state === "off"
              ? `<button class="chip go" data-slug="${tank.slug}" data-act="lights_on">💡 Lights On</button>`
              : `<button class="chip" data-slug="${tank.slug}" data-act="lights_off">💡 Lights Off</button>`;
          let slider = "";
          if (timer) {
            const a = timer.attributes;
            const value = Number(timer.state);
            const valText = value === 0 ? "until off" : `${Math.round(value)} min`;
            slider = `<div class="slider-row">
                <label>Timer</label>
                <input type="range" min="${a.min}" max="${a.max}" step="${a.step}"
                  value="${value}" data-slug="${tank.slug}" data-timer="1">
                <span class="val">${valText}</span>
              </div>`;
          }
          const warn = unresponsiveNote(hass, stage);
          return `<div class="tank">
              <div class="row">
                <span>💡</span>
                <span class="name">${tank.name}</span>
                <span class="status">${statusText}</span>
              </div>
              ${warn}
              ${slider}
              <div class="chips">${chip}</div>
            </div>`;
        })
        .join("");
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `${style}<ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", () => {
        const tank = tanks.find((t) => t.slug === el.dataset.slug);
        if (tank && tank.entities[el.dataset.act]) {
          this._hass.callService("button", "press", {
            entity_id: tank.entities[el.dataset.act],
          });
        }
      });
    });
    this.shadowRoot.querySelectorAll("input[data-timer]").forEach((el) => {
      el.addEventListener("change", () => {
        const tank = tanks.find((t) => t.slug === el.dataset.slug);
        if (tank && tank.entities.light_timer) {
          this._hass.callService("number", "set_value", {
            entity_id: tank.entities.light_timer,
            value: Number(el.value),
          });
        }
      });
    });
  }
}

class FeedAndWaterSpeedsCard extends HTMLElement {
  /* Speed card: per-pump speed readouts with controls. Fan-type pumps
   * (power+speed combined) and switch-backed pumps (e.g. on a Tapo plug)
   * get an Off/On button plus a drag timer — off for X minutes then back
   * on automatically, 0 = off until resumed — backed by the integration's
   * pause_pump/resume_pump services so timers survive HA restarts. Pumps
   * are filterable and relabelable in the card's editor. */

  static getConfigElement() {
    return document.createElement("feedandwater-speeds-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    this._timers = this._timers || {}; // entity_id -> chosen off-minutes
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
    this._syncTicker();
  }

  getCardSize() {
    return 2;
  }

  disconnectedCallback() {
    if (this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
  }

  _syncTicker() {
    const active = this._rows().some((r) => r.pausedUntil);
    if (active && !this._tick) {
      this._tick = setInterval(() => this._render(), 1000);
    } else if (!active && this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
  }

  _rows() {
    if (!this._hass || !this._config) return [];
    const want =
      this._config.entities && this._config.entities.length
        ? new Set(this._config.entities)
        : null;
    const labels = this._config.labels || {};
    const rows = [];
    for (const tank of discoverTanks(this._hass, this._config.tanks)) {
      const sensor = tank.entities.pump_speeds
        ? this._hass.states[tank.entities.pump_speeds]
        : null;
      if (!sensor) continue;
      const paused = sensor.attributes.paused || {};
      const unresponsive = new Set(sensor.attributes.unresponsive || []);
      for (const s of sensor.attributes.speeds || []) {
        if (want && !want.has(s.entity_id)) continue;
        rows.push({
          tank: tank.name,
          ...s,
          name: labels[s.entity_id] || s.name,
          isPaused: s.entity_id in paused,
          pausedUntil: paused[s.entity_id] || null,
          // Anything that can actually be turned off gets the Off/timer
          // controls — fans AND plain switches (Tapo-plug pumps). Number
          // entities are read-only set-points with no off state.
          controllable: /^(fan|switch)\./.test(s.entity_id),
          unresponsive: unresponsive.has(s.entity_id),
        });
      }
    }
    return rows;
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;

    const style = `
      <style>
        ha-card { padding: 12px 16px; height: 100%; box-sizing: border-box; }
        .heading { font-size: 1.1em; font-weight: 500; margin-bottom: 8px; }
        .prow { padding: 8px 0; }
        .prow + .prow { border-top: 1px solid var(--divider-color); }
        .top { display: flex; align-items: baseline; gap: 10px; }
        .pump { font-weight: 500; }
        .tank { color: var(--secondary-text-color); font-size: 0.85em; }
        .status { margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
                  font-size: 0.9em; white-space: nowrap; }
        .status::before { content: ""; width: 9px; height: 9px; border-radius: 50%;
                          background: var(--secondary-text-color); flex: none; }
        .status.on { color: var(--success-color, #43a047); }
        .status.on::before { background: var(--success-color, #43a047); }
        .status.paused { color: var(--warning-color, #ffa600); }
        .status.paused::before { background: var(--warning-color, #ffa600); }
        .status.off { color: var(--secondary-text-color); }
        .value { font-size: 1.35em; font-weight: 500; flex: 0 0 3.2em; text-align: right; }
        .controls { display: flex; align-items: center; gap: 10px; margin-top: 8px;
                    font-size: 0.9em; }
        .controls label { flex: none; color: var(--secondary-text-color); }
        .controls input[type=range] { flex: 1; }
        .controls .val { flex: 0 0 6.5em; text-align: right;
                         color: var(--secondary-text-color); }
        .chip { display: inline-flex; align-items: center; gap: 6px;
                border-radius: 16px; padding: 6px 16px; cursor: pointer;
                font: inherit; font-size: 0.92em; border: 1px solid var(--divider-color);
                background: var(--secondary-background-color);
                color: var(--primary-text-color); flex: none; }
        .chip.go { background: var(--primary-color); color: var(--text-primary-color, #fff);
                   border-color: var(--primary-color); }
        .paused-note { color: var(--secondary-text-color); font-size: 0.9em; flex: 1; }
        .warn { color: var(--error-color, #f44336); font-size: 0.85em; margin-top: 2px; }
        .empty { color: var(--secondary-text-color); font-size: 0.9em; padding: 4px 0; }
      </style>`;

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else {
      const rows = this._rows();
      body = rows.length
        ? rows
            .map((r) => {
              // Explicit status: a coloured dot + words, so "is it running?"
              // is answered without decoding the number or the timer row.
              let statusClass = "off";
              let statusText = "Off";
              if (r.isPaused) {
                statusClass = "paused";
                statusText = r.pausedUntil
                  ? `Off · back on in ${fmtRemaining(r.pausedUntil) || "…"}`
                  : "Off until you tap On";
              } else if (r.on) {
                statusClass = "on";
                statusText = "Running";
              }
              const value =
                r.on && r.value !== null ? Math.round(r.value) + r.unit : "";
              let controls = "";
              if (r.controllable) {
                if (r.isPaused) {
                  controls = `<div class="controls">
                      <span class="paused-note">Tap On to start it again now</span>
                      <button class="chip go" data-eid="${r.entity_id}" data-act="resume">On</button>
                    </div>`;
                } else {
                  const minutes = this._timers[r.entity_id] || 0;
                  const valText = minutes === 0 ? "until I tap On" : `${minutes} min`;
                  controls = `<div class="controls">
                      <label>Off for</label>
                      <input type="range" min="0" max="60" step="5" value="${minutes}"
                        data-eid="${r.entity_id}" data-timer="1">
                      <span class="val">${valText}</span>
                      <button class="chip" data-eid="${r.entity_id}" data-act="pause">Off</button>
                    </div>`;
                }
              }
              const warn = r.unresponsive
                ? `<div class="warn">⚠ Not responding to commands</div>`
                : "";
              const group = this._config.show_groups
                ? `<span class="tank">${r.tank}</span>`
                : "";
              return `<div class="prow">
                  <div class="top">
                    <span class="pump">${r.name}</span>
                    ${group}
                    <span class="status ${statusClass}">${statusText}</span>
                    ${value ? `<span class="value">${value}</span>` : ""}
                  </div>
                  ${warn}
                  ${controls}
                </div>`;
            })
            .join("")
        : `<div class="empty">No pumps to show yet. Go to Settings →
            Devices &amp; Services → Add Integration → Reef Feed &amp; Water →
            "A Speed card" and pick your pumps (or add Speed display(s) in a
            tank's Configure dialog).</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `${style}<ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("input[data-timer]").forEach((el) => {
      el.addEventListener("change", () => {
        this._timers[el.dataset.eid] = Number(el.value);
        this._render();
      });
    });
    this.shadowRoot.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", () => {
        const eid = el.dataset.eid;
        if (el.dataset.act === "pause") {
          this._hass.callService("feedandwater", "pause_pump", {
            entity_id: eid,
            minutes: this._timers[eid] || 0,
          });
        } else {
          this._hass.callService("feedandwater", "resume_pump", { entity_id: eid });
        }
      });
    });
  }
}

class FeedAndWaterSpeedsCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _monitored() {
    const out = [];
    for (const tank of discoverTanks(this._hass, null)) {
      const sensor = tank.entities.pump_speeds
        ? this._hass.states[tank.entities.pump_speeds]
        : null;
      for (const s of (sensor && sensor.attributes.speeds) || []) {
        out.push({ tank: tank.name, entity_id: s.entity_id, name: s.name });
      }
    }
    return out;
  }

  _emit() {
    const config = { type: "custom:feedandwater-speeds-card" };
    if (this._config.title) config.title = this._config.title;
    if (this._config.entities && this._config.entities.length)
      config.entities = this._config.entities;
    if (this._config.labels && Object.keys(this._config.labels).length)
      config.labels = this._config.labels;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _render() {
    // hass may be assigned before setConfig in HA's edit dialog.
    if (!this._config) this._config = {};
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const pumps = this._hass ? this._monitored() : [];
    const selected = new Set(this._config.entities || []);
    const labels = this._config.labels || {};
    const rows = pumps
      .map(
        (p) => `<div class="pump-row">
          <input type="checkbox" value="${p.entity_id}"
            ${!selected.size || selected.has(p.entity_id) ? "checked" : ""}>
          <span class="pname">${p.name} <span class="hint">(${p.tank})</span></span>
          <input type="text" class="label-input" data-eid="${p.entity_id}"
            placeholder="Label" value="${(labels[p.entity_id] || "").replace(/"/g, "&quot;")}">
        </div>`
      )
      .join("");
    this.shadowRoot.innerHTML = `
      <style>
        .wrap { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
        .hint { color: var(--secondary-text-color); font-size: 0.88em; }
        .pump-row { display: flex; align-items: center; gap: 8px; }
        .pname { flex: 1; min-width: 0; }
        input[type=text] { padding: 6px 8px; font: inherit;
          background: var(--card-background-color); color: var(--primary-text-color);
          border: 1px solid var(--divider-color); border-radius: 4px; }
        .label-input { flex: 0 0 10em; }
      </style>
      <div class="wrap">
        <label>Title (optional)
          <input type="text" id="title" value="${(this._config.title || "").replace(/"/g, "&quot;")}"></label>
        <div>Pumps shown ${pumps.length ? "" : "<span class='hint'>(none monitored yet — Settings → Devices &amp; Services → Add Integration → Reef Feed &amp; Water → \"A Speed card\")</span>"}</div>
        ${rows}
        <div class="hint">Untick pumps to hide them; type a Label to rename a
          pump on the card (e.g. "Return Pump" instead of the device name).</div>
        <label><input type="checkbox" id="show-groups" ${this._config.show_groups ? "checked" : ""}>
          Show which tank / entry each pump belongs to</label>
      </div>`;

    this.shadowRoot.getElementById("title").addEventListener("input", (ev) => {
      this._config.title = ev.target.value;
      this._emit();
    });
    this.shadowRoot.getElementById("show-groups").addEventListener("change", (ev) => {
      if (ev.target.checked) this._config.show_groups = true;
      else delete this._config.show_groups;
      this._emit();
    });
    this.shadowRoot.querySelectorAll("input[type=checkbox][value]").forEach((el) => {
      el.addEventListener("change", () => {
        const checked = [...this.shadowRoot.querySelectorAll("input[type=checkbox][value]")]
          .filter((c) => c.checked)
          .map((c) => c.value);
        this._config.entities = checked.length === pumps.length ? [] : checked;
        this._emit();
      });
    });
    this.shadowRoot.querySelectorAll(".label-input").forEach((el) => {
      el.addEventListener("input", () => {
        const labels = { ...(this._config.labels || {}) };
        if (el.value.trim()) labels[el.dataset.eid] = el.value.trim();
        else delete labels[el.dataset.eid];
        this._config.labels = labels;
        this._emit();
      });
    });
  }
}

class FeedAndWaterMaintenanceCard extends HTMLElement {
  /* Maintenance card: repeatable "mark it done" tasks (fleece roll, ATO
   * reset, filter socks…) — time since last done, an optional live status
   * sensor from the equipment's own integration, and a Done button that
   * fires the linked action entities and stamps the date. */

  static getConfigElement() {
    return document.createElement("feedandwater-maintenance-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 2;
  }

  _tasks() {
    return discoverTanks(this._hass, this._config && this._config.tanks).filter(
      (t) => t.entities.done && t.entities.last_done
    );
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;

    const style = `
      <style>
        ha-card { padding: 12px 16px; height: 100%; box-sizing: border-box; }
        .heading { font-size: 1.1em; font-weight: 500; margin-bottom: 8px; }
        .task { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
        .task + .task { border-top: 1px solid var(--divider-color); }
        .info { flex: 1; min-width: 0; }
        .name { font-weight: 500; }
        .ago { color: var(--secondary-text-color); font-size: 0.88em; }
        .stat { font-size: 0.88em; padding: 3px 10px; border-radius: 12px;
                background: var(--secondary-background-color);
                color: var(--secondary-text-color); }
        .stat.alert { background: var(--error-color, #f44336); color: #fff; }
        .done-btn { border-radius: 16px; padding: 6px 16px; cursor: pointer;
                font: inherit; font-size: 0.92em; border: 1px solid var(--primary-color);
                background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .empty { color: var(--secondary-text-color); font-size: 0.9em; padding: 4px 0; }
      </style>`;

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else {
      const tasks = this._tasks();
      body = tasks.length
        ? tasks
            .map((task) => {
              const last = hass.states[task.entities.last_done];
              let ago = "never";
              if (last && !["unknown", "unavailable"].includes(last.state)) {
                const days = (Date.now() - new Date(last.state).getTime()) / 86400000;
                if (days >= 1.5) ago = `${Math.round(days)} days ago`;
                else if (days >= 1) ago = "1 day ago";
                else if (days * 24 >= 1) ago = `${Math.round(days * 24)}h ago`;
                else ago = "just now";
              }
              let stat = "";
              const statusId = last && last.attributes.status_entity;
              if (statusId && hass.states[statusId]) {
                const s = hass.states[statusId];
                const alert = s.state === "on" || s.state === "problem";
                const label = s.attributes.friendly_name || statusId;
                stat = `<span class="stat ${alert ? "alert" : ""}">${label}: ${s.state}</span>`;
              }
              return `<div class="task">
                  <div class="info">
                    <div class="name">${task.name}</div>
                    <div class="ago">Last done: ${ago}</div>
                  </div>
                  ${stat}
                  <button class="done-btn" data-slug="${task.slug}">Done</button>
                </div>`;
            })
            .join("")
        : `<div class="empty">No maintenance tasks yet — add one via
            Settings &gt; Devices &amp; Services &gt; Add Integration &gt;
            Reef Feed &amp; Water &gt; "A maintenance task".</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `${style}<ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll(".done-btn").forEach((el) => {
      el.addEventListener("click", () => {
        const task = this._tasks().find((t) => t.slug === el.dataset.slug);
        if (task) {
          this._hass.callService("button", "press", {
            entity_id: task.entities.done,
          });
        }
      });
    });
  }
}

class FeedAndWaterCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  // Overridden by the per-card editor subclasses below.
  get cardType() {
    return "custom:feedandwater-card";
  }

  _emit() {
    const config = { type: this.cardType };
    if (this._config.title) config.title = this._config.title;
    if (this._config.tanks && this._config.tanks.length) config.tanks = this._config.tanks;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _render() {
    // HA's edit dialog can assign hass before setConfig — never assume
    // _config exists yet.
    if (!this._config) this._config = {};
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const tanks = discoverTanks(this._hass, null);
    const selected = new Set(this._config.tanks || []);
    const rows = tanks
      .map(
        (t) => `<label class="tank-row">
          <input type="checkbox" value="${t.slug}"
            ${!selected.size || selected.has(t.slug) ? "checked" : ""}>
          ${t.name} <span class="slug">(${t.slug})</span></label>`
      )
      .join("");
    this.shadowRoot.innerHTML = `
      <style>
        .wrap { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
        .hint { color: var(--secondary-text-color); font-size: 0.88em; }
        .tank-row { display: flex; align-items: center; gap: 8px; }
        .slug { color: var(--secondary-text-color); font-size: 0.88em; }
        input[type=text] { padding: 6px 8px; font: inherit;
          background: var(--card-background-color); color: var(--primary-text-color);
          border: 1px solid var(--divider-color); border-radius: 4px; }
      </style>
      <div class="wrap">
        <label>Title (optional)
          <input type="text" id="title" value="${this._config.title || ""}"></label>
        <div>Tanks shown ${tanks.length ? "" : "<span class='hint'>(none found yet)</span>"}</div>
        ${rows}
        <div class="hint">Untick tanks to hide them; all ticked = show every tank
          (including ones added later).</div>
      </div>`;

    this.shadowRoot.getElementById("title").addEventListener("input", (ev) => {
      this._config.title = ev.target.value;
      this._emit();
    });
    this.shadowRoot.querySelectorAll("input[type=checkbox]").forEach((el) => {
      el.addEventListener("change", () => {
        const checked = [...this.shadowRoot.querySelectorAll("input[type=checkbox]")]
          .filter((c) => c.checked)
          .map((c) => c.value);
        // Everything ticked = no filter (future tanks appear automatically).
        this._config.tanks = checked.length === tanks.length ? [] : checked;
        this._emit();
      });
    });
  }
}

class FeedAndWaterDevicesCardEditor extends FeedAndWaterCardEditor {
  get cardType() {
    return "custom:feedandwater-devices-card";
  }
}

class FeedAndWaterLightsCardEditor extends FeedAndWaterCardEditor {
  get cardType() {
    return "custom:feedandwater-lights-card";
  }
}

class FeedAndWaterMaintenanceCardEditor extends FeedAndWaterCardEditor {
  get cardType() {
    return "custom:feedandwater-maintenance-card";
  }
}

customElements.define("feedandwater-card", FeedAndWaterCard);
customElements.define("feedandwater-card-editor", FeedAndWaterCardEditor);
customElements.define("feedandwater-devices-card", FeedAndWaterDevicesCard);
customElements.define("feedandwater-devices-card-editor", FeedAndWaterDevicesCardEditor);
customElements.define("feedandwater-lights-card", FeedAndWaterLightsCard);
customElements.define("feedandwater-lights-card-editor", FeedAndWaterLightsCardEditor);
customElements.define("feedandwater-speeds-card", FeedAndWaterSpeedsCard);
customElements.define("feedandwater-speeds-card-editor", FeedAndWaterSpeedsCardEditor);
customElements.define("feedandwater-maintenance-card", FeedAndWaterMaintenanceCard);
customElements.define(
  "feedandwater-maintenance-card-editor",
  FeedAndWaterMaintenanceCardEditor
);

window.customCards = window.customCards || [];
window.customCards.push(
  {
    type: "feedandwater-card",
    name: "Reef Feed & Water",
    description:
      "Compact per-tank feed & water-change controls for the Reef Feed & Water integration. Zero config — discovers your tanks automatically.",
  },
  {
    type: "feedandwater-devices-card",
    name: "Reef Feed & Water — Device Tracker",
    description:
      "Off-duration table for each tank's tracked devices, with the tracked list editable on the card.",
  },
  {
    type: "feedandwater-lights-card",
    name: "Reef Feed & Water — Lights",
    description:
      "Per-tank light control with the auto-off timer slider front and center (0 = stay on until turned off).",
  },
  {
    type: "feedandwater-speeds-card",
    name: "Reef Feed & Water — Speeds",
    description:
      "Per-pump speed readouts with Off/On controls and off-for-X-minutes timers, filterable and relabelable — e.g. just the wavemakers.",
  },
  {
    type: "feedandwater-maintenance-card",
    name: "Reef Feed & Water — Maintenance",
    description:
      "Repeatable mark-it-done tasks (fleece roll, ATO reset…) with time-since counters, live equipment status, and a Done button that fires the linked action.",
  }
);
