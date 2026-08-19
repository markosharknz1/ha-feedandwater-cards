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

  // A tank must have its own start_feed button (full tank) or lights_on
  // button (standalone light timer) — filters out lookalike entities from
  // the manual-YAML flavor of this pack.
  const result = [...tanks.values()].filter(
    (t) => t.entities.start_feed || t.entities.lights_on
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
    const tanks = discoverTanks(hass, this._config.tanks);

    const style = `
      <style>
        ha-card { padding: 12px 16px; }
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
        .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .chip { display: inline-flex; align-items: center; gap: 6px;
                border-radius: 16px; padding: 5px 14px; cursor: pointer;
                font: inherit; font-size: 0.9em; border: 1px solid var(--divider-color);
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
          return `<div class="tank">
              <div class="row">
                <span class="dot ${status.dot}"></span>
                <span class="name">${tank.name}</span>
                <span class="status">${status.text}</span>
                <button class="gear" data-slug="${tank.slug}" data-gear="1"
                  title="Tank settings">⚙</button>
              </div>
              ${speedsLine}
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
        ha-card { padding: 12px 16px; }
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
        ha-card { padding: 12px 16px; }
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
          return `<div class="tank">
              <div class="row">
                <span>💡</span>
                <span class="name">${tank.name}</span>
                <span class="status">${statusText}</span>
              </div>
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

customElements.define("feedandwater-card", FeedAndWaterCard);
customElements.define("feedandwater-card-editor", FeedAndWaterCardEditor);
customElements.define("feedandwater-devices-card", FeedAndWaterDevicesCard);
customElements.define("feedandwater-devices-card-editor", FeedAndWaterDevicesCardEditor);
customElements.define("feedandwater-lights-card", FeedAndWaterLightsCard);
customElements.define("feedandwater-lights-card-editor", FeedAndWaterLightsCardEditor);

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
  }
);
