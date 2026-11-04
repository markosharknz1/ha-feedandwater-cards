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
  "equipment",
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
      t.entities.pump_speeds ||
      t.entities.equipment
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

const fmtSince = (iso) => {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
};

// binary_sensor classes where "on" is the bad state
const PROBLEM_CLASSES = new Set([
  "problem", "safety", "smoke", "gas", "carbon_monoxide", "moisture", "tamper",
  "battery", "heat", "cold", "vibration",
]);

class FeedAndWaterEquipmentCard extends HTMLElement {
  /* Equipment status card: one row per watched device (dosers, ATO,
   * heaters, probes…) with an explicit coloured status, how long it has
   * been like that, an On/Off button for switchable gear, and a red
   * "Unavailable" for anything that dropped off the network. Devices are
   * filterable and relabelable in the card's editor. */

  static getConfigElement() {
    return document.createElement("feedandwater-equipment-card-editor");
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
    if (!this._tick) this._tick = setInterval(() => this._render(), 30000);
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

  _rows() {
    if (!this._hass || !this._config) return [];
    const want =
      this._config.entities && this._config.entities.length
        ? new Set(this._config.entities)
        : null;
    const labels = this._config.labels || {};
    const rows = [];
    for (const tank of discoverTanks(this._hass, this._config.tanks)) {
      const sensor = tank.entities.equipment
        ? this._hass.states[tank.entities.equipment]
        : null;
      if (!sensor) continue;
      for (const d of sensor.attributes.devices || []) {
        if (want && !want.has(d.entity_id)) continue;
        // Prefer the live state object (fresher than the attribute copy).
        const st = this._hass.states[d.entity_id];
        rows.push({
          ...d,
          group: tank.name,
          name: labels[d.entity_id] || (st && st.attributes.friendly_name) || d.name,
          state: st ? st.state : null,
          available: !!st && st.state !== "unavailable" && st.state !== "unknown",
          unit: (st && st.attributes.unit_of_measurement) || d.unit || "",
          device_class: (st && st.attributes.device_class) || d.device_class,
          last_changed: st ? st.last_changed : d.last_changed,
          stateObj: st,
        });
      }
    }
    return rows;
  }

  _describe(r) {
    // -> {cls, text, value, switchable}
    if (!r.available) return { cls: "bad", text: "Unavailable", value: "" };
    const onOff = ["switch", "fan", "light"].includes(r.domain);
    if (onOff) {
      return r.state === "on"
        ? { cls: "on", text: "Running", value: "", switchable: true }
        : { cls: "off", text: "Off", value: "", switchable: true };
    }
    if (r.domain === "binary_sensor") {
      let text = null;
      try {
        if (this._hass.formatEntityState && r.stateObj)
          text = this._hass.formatEntityState(r.stateObj);
      } catch (_e) {
        text = null;
      }
      const isOn = r.state === "on";
      const bad = PROBLEM_CLASSES.has(r.device_class || "");
      if (!text) {
        if (bad) text = isOn ? "Problem" : "OK";
        else text = isOn ? "Active" : "Clear";
      }
      const cls = isOn ? (bad ? "bad" : "on") : bad ? "on" : "off";
      return { cls, text, value: "" };
    }
    // sensor / number: show the reading
    const num = Number(r.state);
    const value = Number.isFinite(num)
      ? `${Math.round(num * 10) / 10}${r.unit ? " " + r.unit : ""}`
      : String(r.state);
    return { cls: "on", text: "OK", value };
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;

    const style = `
      <style>
        ha-card { padding: 12px 16px; height: 100%; box-sizing: border-box; }
        .heading { font-size: 1.1em; font-weight: 500; margin-bottom: 8px; }
        .erow { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
        .erow + .erow { border-top: 1px solid var(--divider-color); }
        .who { flex: 1; min-width: 0; }
        .name { font-weight: 500; }
        .group { color: var(--secondary-text-color); font-size: 0.85em; margin-left: 6px; }
        .since { color: var(--secondary-text-color); font-size: 0.82em; margin-top: 2px; }
        .status { display: inline-flex; align-items: center; gap: 6px;
                  font-size: 0.9em; white-space: nowrap; }
        .status::before { content: ""; width: 9px; height: 9px; border-radius: 50%;
                          background: var(--secondary-text-color); flex: none; }
        .status.on { color: var(--success-color, #43a047); }
        .status.on::before { background: var(--success-color, #43a047); }
        .status.bad { color: var(--error-color, #f44336); font-weight: 500; }
        .status.bad::before { background: var(--error-color, #f44336); }
        .status.off { color: var(--secondary-text-color); }
        .value { font-size: 1.25em; font-weight: 500; white-space: nowrap; }
        .chip { display: inline-flex; align-items: center; border-radius: 16px;
                padding: 6px 16px; cursor: pointer; font: inherit; font-size: 0.92em;
                border: 1px solid var(--divider-color);
                background: var(--secondary-background-color);
                color: var(--primary-text-color); flex: none; }
        .chip.go { background: var(--primary-color); color: var(--text-primary-color, #fff);
                   border-color: var(--primary-color); }
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
              const d = this._describe(r);
              const since = fmtSince(r.last_changed);
              const sinceLine = since
                ? `<div class="since">${d.text === "Unavailable" ? "since" : "for"} ${since}</div>`
                : "";
              const group = this._config.show_groups
                ? `<span class="group">${r.group}</span>`
                : "";
              const button = d.switchable && r.available
                ? r.state === "on"
                  ? `<button class="chip" data-eid="${r.entity_id}" data-act="turn_off">Off</button>`
                  : `<button class="chip go" data-eid="${r.entity_id}" data-act="turn_on">On</button>`
                : "";
              return `<div class="erow">
                  <div class="who">
                    <span class="name">${r.name}</span>${group}
                    ${sinceLine}
                  </div>
                  <span class="status ${d.cls}">${d.text}</span>
                  ${d.value ? `<span class="value">${d.value}</span>` : ""}
                  ${button}
                </div>`;
            })
            .join("")
        : `<div class="empty">No equipment to show yet. Go to Settings →
            Devices &amp; Services → Add Integration → Reef Feed &amp; Water →
            "An Equipment status card" and pick your devices (or add Equipment
            to watch in a tank's Configure dialog).</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `${style}<ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", () => {
        this._hass.callService("homeassistant", el.dataset.act, {
          entity_id: el.dataset.eid,
        });
      });
    });
  }
}

class FeedAndWaterEquipmentCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _emit() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _devices() {
    const out = [];
    for (const tank of discoverTanks(this._hass, null)) {
      const sensor = tank.entities.equipment
        ? this._hass.states[tank.entities.equipment]
        : null;
      if (!sensor) continue;
      for (const d of sensor.attributes.devices || []) {
        out.push({ ...d, group: tank.name });
      }
    }
    return out;
  }

  _render() {
    if (!this._config) this._config = {};
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._hass) {
      this.shadowRoot.innerHTML = `<div>Loading…</div>`;
      return;
    }
    const devices = this._devices();
    const chosen = new Set(this._config.entities || []);
    const labels = this._config.labels || {};
    const rows = devices
      .map(
        (d) => `<div class="pump-row">
          <input type="checkbox" value="${d.entity_id}"
            ${chosen.size === 0 || chosen.has(d.entity_id) ? "checked" : ""}>
          <span class="pname">${d.name} <span class="hint">(${d.group})</span></span>
          <input type="text" class="label-input" placeholder="Label"
            data-eid="${d.entity_id}" value="${(labels[d.entity_id] || "").replace(/"/g, "&quot;")}">
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
        <div>Devices shown ${devices.length ? "" : "<span class='hint'>(none watched yet — Settings → Devices &amp; Services → Add Integration → Reef Feed &amp; Water → \"An Equipment status card\")</span>"}</div>
        ${rows}
        <div class="hint">Untick devices to hide them; type a Label to rename one
          on the card (e.g. "Doser 1 — Alk").</div>
        <label><input type="checkbox" id="show-groups" ${this._config.show_groups ? "checked" : ""}>
          Show which tank / entry each device belongs to</label>
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
        this._config.entities = checked.length === devices.length ? [] : checked;
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

/* ------------------------------------------------------------------ */
/* RedSea device cards (ReefMat / ReefATO+)                            */
/*                                                                    */
/* These discover devices straight from the Red Sea ReefBeat          */
/* integration (Elwinmage/ha-reefbeat-component, platform "redsea")   */
/* via HA's entity registry — zero config. Each entity is classified  */
/* by its registry translation_key when the frontend exposes it, with */
/* an entity_id-suffix fallback, so renamed entities still resolve.   */
/* ------------------------------------------------------------------ */

function redseaDevices(hass, roleSpec) {
  // roleSpec: {role: [domains...]} — collect matching entities per device.
  if (!hass || !hass.entities) return [];
  const roles = Object.keys(roleSpec).sort((a, b) => b.length - a.length);
  const byDevice = new Map();
  for (const [entityId, entry] of Object.entries(hass.entities)) {
    if (entry.platform !== "redsea" || !entry.device_id) continue;
    const dot = entityId.indexOf(".");
    const domain = entityId.slice(0, dot);
    const objectId = entityId.slice(dot + 1);
    const tk = entry.translation_key;
    let role = null;
    for (const r of roles) {
      if (!roleSpec[r].includes(domain)) continue;
      if (tk === r || (!tk && (objectId === r || objectId.endsWith("_" + r)))) {
        role = r;
        break;
      }
    }
    if (!role) continue;
    if (!byDevice.has(entry.device_id)) {
      byDevice.set(entry.device_id, { id: entry.device_id, name: null, entities: {} });
    }
    const dev = byDevice.get(entry.device_id);
    if (dev.entities[role] === undefined) dev.entities[role] = entityId;
    if (!dev.name && hass.devices && hass.devices[entry.device_id]) {
      const d = hass.devices[entry.device_id];
      dev.name = d.name_by_user || d.name;
    }
  }
  const out = [...byDevice.values()];
  for (const d of out) if (!d.name) d.name = "RedSea device";
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const rsState = (hass, dev, role) => {
  const id = dev.entities[role];
  return id ? hass.states[id] : null;
};
const rsNum = (st) => {
  if (!st || st.state === "unavailable" || st.state === "unknown") return null;
  const n = Number(st.state);
  return Number.isFinite(n) ? n : null;
};
const rsUnavailable = (hass, dev) =>
  Object.values(dev.entities).some((id) => {
    const st = hass.states[id];
    return !st || st.state === "unavailable";
  });
const humanize = (v) => (v ? String(v).replace(/_/g, " ") : v);

const RS_SHARED_CSS = `
  ha-card { padding: 12px 16px; height: 100%; box-sizing: border-box; }
  .heading { font-size: 1.1em; font-weight: 500; margin-bottom: 8px; }
  .drow { padding: 10px 0; }
  .drow + .drow { border-top: 1px solid var(--divider-color); }
  .top { display: flex; align-items: baseline; gap: 10px; }
  .name { font-weight: 500; flex: 1; min-width: 0; }
  .big { font-size: 1.35em; font-weight: 500; white-space: nowrap; }
  .big .unit { font-size: 0.65em; color: var(--secondary-text-color); }
  .sub { color: var(--secondary-text-color); font-size: 0.88em; margin-top: 2px; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-size: 0.9em;
            white-space: nowrap; }
  .status::before { content: ""; width: 9px; height: 9px; border-radius: 50%;
                    background: var(--secondary-text-color); flex: none; }
  .status.good { color: var(--success-color, #43a047); }
  .status.good::before { background: var(--success-color, #43a047); }
  .status.warn-s { color: var(--warning-color, #ffa600); }
  .status.warn-s::before { background: var(--warning-color, #ffa600); }
  .status.bad { color: var(--error-color, #f44336); font-weight: 500; }
  .status.bad::before { background: var(--error-color, #f44336); }
  .warn { color: var(--error-color, #f44336); font-size: 0.88em; margin-top: 4px; }
  .buttons { display: flex; align-items: center; gap: 8px; margin-top: 8px;
             flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 16px;
          padding: 6px 16px; cursor: pointer; font: inherit; font-size: 0.92em;
          border: 1px solid var(--divider-color);
          background: var(--secondary-background-color);
          color: var(--primary-text-color); flex: none; }
  .chip.go { background: var(--primary-color); color: var(--text-primary-color, #fff);
             border-color: var(--primary-color); }
  .chip.armed { background: var(--error-color, #f44336); color: #fff;
                border-color: var(--error-color, #f44336); }
  .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff);
             border-color: var(--primary-color); }
  .empty { color: var(--secondary-text-color); font-size: 0.9em; padding: 4px 0; }
`;

const MAT_ROLES = {
  days_till_end_of_roll: ["sensor"],
  remaining_length: ["sensor"],
  today_usage: ["sensor"],
  daily_average_usage: ["sensor"],
  unclean_sensor: ["binary_sensor"],
  advance: ["button"],
  new_roll: ["button"],
  auto_advance: ["switch"],
};

class FeedAndWaterReefMatCard extends HTMLElement {
  /* ReefMat card: per-mat fleece status — days left on the roll front
   * and center, usage line, dirty-sensor warning — with Advance and a
   * two-tap New Roll (first tap arms it, so a stray touch can't reset
   * the roll counter). */

  static getConfigElement() {
    return document.createElement("feedandwater-reefmat-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    this._armed = null; // entity_id of the armed New Roll button
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 2;
  }

  _devices() {
    const want =
      this._config.devices && this._config.devices.length
        ? new Set(this._config.devices)
        : null;
    return redseaDevices(this._hass, MAT_ROLES).filter(
      (d) =>
        (d.entities.new_roll || d.entities.days_till_end_of_roll) &&
        (!want || want.has(d.id))
    );
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    const labels = this._config.labels || {};

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else {
      const devs = this._devices();
      body = devs.length
        ? devs
            .map((d) => {
              const days = rsNum(rsState(hass, d, "days_till_end_of_roll"));
              const len = rsNum(rsState(hass, d, "remaining_length"));
              const today = rsNum(rsState(hass, d, "today_usage"));
              const avg = rsNum(rsState(hass, d, "daily_average_usage"));
              const unclean = rsState(hass, d, "unclean_sensor");
              const off = rsUnavailable(hass, d);
              const big =
                days !== null
                  ? `${Math.round(days)}<span class="unit"> days left</span>`
                  : "";
              const subBits = [];
              if (len !== null) subBits.push(`${len.toFixed(1)} m on the roll`);
              if (today !== null) subBits.push(`today ${today.toFixed(2)} m`);
              if (avg !== null) subBits.push(`avg ${avg.toFixed(2)} m/day`);
              let warn = "";
              if (off) warn = `<div class="warn">⚠ Unavailable — check the ReefMat's connection</div>`;
              else if (unclean && unclean.state === "on")
                warn = `<div class="warn">⚠ Roll sensor needs cleaning</div>`;
              const armed = this._armed === d.entities.new_roll;
              const buttons = [];
              if (d.entities.advance)
                buttons.push(
                  `<button class="chip go" data-press="${d.entities.advance}">Advance</button>`
                );
              if (d.entities.new_roll)
                buttons.push(
                  armed
                    ? `<button class="chip armed" data-newroll="${d.entities.new_roll}">Tap again — new roll fitted</button>`
                    : `<button class="chip" data-newroll="${d.entities.new_roll}">New roll…</button>`
                );
              return `<div class="drow">
                  <div class="top">
                    <span class="name">${labels[d.id] || d.name}</span>
                    <span class="big">${big}</span>
                  </div>
                  ${subBits.length ? `<div class="sub">${subBits.join(" · ")}</div>` : ""}
                  ${warn}
                  ${buttons.length ? `<div class="buttons">${buttons.join("")}</div>` : ""}
                </div>`;
            })
            .join("")
        : `<div class="empty">No ReefMat found. This card needs the Red Sea
            ReefBeat integration (Elwinmage/ha-reefbeat-component) with your
            ReefMat added.</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `<style>${RS_SHARED_CSS}</style><ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("[data-press]").forEach((el) => {
      el.addEventListener("click", () => {
        this._hass.callService("button", "press", { entity_id: el.dataset.press });
      });
    });
    this.shadowRoot.querySelectorAll("[data-newroll]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.newroll;
        if (this._armed === id) {
          this._armed = null;
          this._hass.callService("button", "press", { entity_id: id });
        } else {
          this._armed = id;
          // Disarm by itself if the second tap never comes.
          setTimeout(() => {
            if (this._armed === id) {
              this._armed = null;
              this._render();
            }
          }, 6000);
        }
        this._render();
      });
    });
  }
}

const ATO_ROLES = {
  days_till_empty: ["sensor"],
  volume_left: ["sensor"],
  water_level: ["sensor", "binary_sensor"],
  leak_sensor_status: ["sensor"],
  today_fills: ["sensor"],
  today_volume_usage: ["sensor"],
  is_pump_on: ["binary_sensor"],
  fill: ["button"],
  stop_fill: ["button"],
  resume: ["button"],
  auto_fill: ["switch"],
};

class FeedAndWaterReefAtoCard extends HTMLElement {
  /* ReefATO+ card: water level status, reservoir days/volume left,
   * today's fills, leak alarm — with Fill / Stop / Resume buttons and
   * the Auto fill toggle. */

  static getConfigElement() {
    return document.createElement("feedandwater-reefato-card-editor");
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

  _devices() {
    const want =
      this._config.devices && this._config.devices.length
        ? new Set(this._config.devices)
        : null;
    return redseaDevices(this._hass, ATO_ROLES).filter(
      (d) =>
        (d.entities.auto_fill || d.entities.stop_fill || d.entities.days_till_empty) &&
        (!want || want.has(d.id))
    );
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    const labels = this._config.labels || {};

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else {
      const devs = this._devices();
      body = devs.length
        ? devs
            .map((d) => {
              const off = rsUnavailable(hass, d);
              const level = rsState(hass, d, "water_level");
              const leak = rsState(hass, d, "leak_sensor_status");
              const pumpOn = rsState(hass, d, "is_pump_on");
              const days = rsNum(rsState(hass, d, "days_till_empty"));
              const volLeft = rsNum(rsState(hass, d, "volume_left"));
              const fills = rsNum(rsState(hass, d, "today_fills"));
              const todayVol = rsNum(rsState(hass, d, "today_volume_usage"));
              const autoFill = rsState(hass, d, "auto_fill");

              // Water level -> coloured status words
              let cls = "off";
              let text = "No level reading";
              if (off) {
                cls = "bad";
                text = "Unavailable";
              } else if (level) {
                const v = level.state;
                if (v === "on" || v === "off") {
                  // binary water_level sensor
                  cls = v === "on" ? "good" : "warn-s";
                  text = v === "on" ? "Level OK" : "Level low";
                } else if (v.startsWith("desired")) {
                  cls = "good";
                  text = "At level";
                } else if (v === "error") {
                  cls = "bad";
                  text = "Sensor error";
                } else {
                  cls = "warn-s";
                  text = "Level " + humanize(v);
                }
              }
              const big =
                days !== null
                  ? `${Math.round(days)}<span class="unit"> days of top-up</span>`
                  : "";
              const subBits = [];
              if (volLeft !== null)
                subBits.push(
                  volLeft >= 1000
                    ? `${(volLeft / 1000).toFixed(1)} L in reservoir`
                    : `${Math.round(volLeft)} mL in reservoir`
                );
              if (fills !== null) subBits.push(`today ${Math.round(fills)} fills`);
              if (todayVol !== null) subBits.push(`${Math.round(todayVol)} mL`);
              if (pumpOn && pumpOn.state === "on") subBits.push("pump running");
              let warn = "";
              if (!off && leak && leak.state !== "dry" && leak.state !== "unknown")
                warn = `<div class="warn">⚠ Leak detected: ${humanize(leak.state)}</div>`;
              else if (off)
                warn = `<div class="warn">⚠ Unavailable — check the ATO's connection</div>`;

              const buttons = [];
              if (d.entities.fill)
                buttons.push(`<button class="chip go" data-press="${d.entities.fill}">Fill</button>`);
              if (d.entities.stop_fill)
                buttons.push(`<button class="chip" data-press="${d.entities.stop_fill}">Stop</button>`);
              if (d.entities.resume)
                buttons.push(`<button class="chip" data-press="${d.entities.resume}">Resume</button>`);
              if (autoFill)
                buttons.push(
                  `<button class="chip ${autoFill.state === "on" ? "on" : ""}"
                     data-toggle="${d.entities.auto_fill}">Auto fill ${autoFill.state === "on" ? "on" : "off"}</button>`
                );
              return `<div class="drow">
                  <div class="top">
                    <span class="name">${labels[d.id] || d.name}</span>
                    <span class="status ${cls}">${text}</span>
                    <span class="big">${big}</span>
                  </div>
                  ${subBits.length ? `<div class="sub">${subBits.join(" · ")}</div>` : ""}
                  ${warn}
                  ${buttons.length ? `<div class="buttons">${buttons.join("")}</div>` : ""}
                </div>`;
            })
            .join("")
        : `<div class="empty">No ReefATO+ found. This card needs the Red Sea
            ReefBeat integration (Elwinmage/ha-reefbeat-component) with your
            ReefATO+ added.</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `<style>${RS_SHARED_CSS}</style><ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("[data-press]").forEach((el) => {
      el.addEventListener("click", () => {
        this._hass.callService("button", "press", { entity_id: el.dataset.press });
      });
    });
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.toggle;
        const st = this._hass.states[id];
        this._hass.callService(
          "switch",
          st && st.state === "on" ? "turn_off" : "turn_on",
          { entity_id: id }
        );
      });
    });
  }
}

class FeedAndWaterRedSeaEditor extends HTMLElement {
  /* Shared editor for the ReefMat / ReefATO+ cards: title, device
   * checkboxes, per-device labels. Subclasses set _roles/_signature. */

  setConfig(config) {
    this._config = { ...(config || {}) };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _emit() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _render() {
    if (!this._config) this._config = {};
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._hass) {
      this.shadowRoot.innerHTML = `<div>Loading…</div>`;
      return;
    }
    const devices = redseaDevices(this._hass, this._roles).filter(this._signature);
    const chosen = new Set(this._config.devices || []);
    const labels = this._config.labels || {};
    const rows = devices
      .map(
        (d) => `<div class="pump-row">
          <input type="checkbox" value="${d.id}"
            ${chosen.size === 0 || chosen.has(d.id) ? "checked" : ""}>
          <span class="pname">${d.name}</span>
          <input type="text" class="label-input" placeholder="Label"
            data-did="${d.id}" value="${(labels[d.id] || "").replace(/"/g, "&quot;")}">
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
        <div>Devices shown ${devices.length ? "" : `<span class='hint'>(none found — install the Red Sea ReefBeat integration and add your ${this._kind})</span>`}</div>
        ${rows}
      </div>`;

    this.shadowRoot.getElementById("title").addEventListener("input", (ev) => {
      this._config.title = ev.target.value;
      this._emit();
    });
    this.shadowRoot.querySelectorAll("input[type=checkbox][value]").forEach((el) => {
      el.addEventListener("change", () => {
        const checked = [...this.shadowRoot.querySelectorAll("input[type=checkbox][value]")]
          .filter((c) => c.checked)
          .map((c) => c.value);
        this._config.devices = checked.length === devices.length ? [] : checked;
        this._emit();
      });
    });
    this.shadowRoot.querySelectorAll(".label-input").forEach((el) => {
      el.addEventListener("input", () => {
        const labels = { ...(this._config.labels || {}) };
        if (el.value.trim()) labels[el.dataset.did] = el.value.trim();
        else delete labels[el.dataset.did];
        this._config.labels = labels;
        this._emit();
      });
    });
  }
}

class FeedAndWaterReefMatCardEditor extends FeedAndWaterRedSeaEditor {
  constructor() {
    super();
    this._roles = MAT_ROLES;
    this._kind = "ReefMat";
    this._signature = (d) => d.entities.new_roll || d.entities.days_till_end_of_roll;
  }
}

class FeedAndWaterReefAtoCardEditor extends FeedAndWaterRedSeaEditor {
  constructor() {
    super();
    this._roles = ATO_ROLES;
    this._kind = "ReefATO+";
    this._signature = (d) =>
      d.entities.auto_fill || d.entities.stop_fill || d.entities.days_till_empty;
  }
}


const DOSE_ROLES = {
  head_state: ["sensor"],
  supplement: ["sensor"],
  remaining_days: ["sensor"],
  daily_dose: ["sensor"],
  doses_today: ["sensor"],
  auto_dosed_today: ["sensor"],
  manual_dosed_today: ["sensor"],
  manual_head_volume: ["number"],
  manual_head: ["button"],
  schedule_enabled: ["switch"],
};

class FeedAndWaterReefDoseCard extends HTMLElement {
  /* ReefDose card: one row per dosing head (ReefBeat models each head
   * as its own HA device, "Doser head N"). Shows the supplement, head
   * state, container days left and today's dosing, with a schedule
   * toggle and a manual dose: -/+ steppers set the volume (sliders are
   * useless when the entity range is 0-300 mL and real doses are
   * single digits) and the Dose button is two-tap armed so chemicals
   * never go in from a stray touch. */

  static getConfigElement() {
    return document.createElement("feedandwater-reefdose-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    this._armed = null; // entity_id of the armed Dose button
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 2;
  }

  _devices() {
    const want =
      this._config.devices && this._config.devices.length
        ? new Set(this._config.devices)
        : null;
    return redseaDevices(this._hass, DOSE_ROLES).filter(
      (d) =>
        (d.entities.manual_head || d.entities.supplement) &&
        (!want || want.has(d.id))
    );
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    const labels = this._config.labels || {};

    const extra = `
      .supp { color: var(--secondary-text-color); font-size: 0.88em; }
      .stepper { display: inline-flex; align-items: center; gap: 2px; }
      .stepper .chip { padding: 6px 12px; }
      .vol { min-width: 4.2em; text-align: center; font-weight: 500; }
    `;

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else {
      const devs = this._devices();
      body = devs.length
        ? devs
            .map((d) => {
              const off = rsUnavailable(hass, d);
              const headState = rsState(hass, d, "head_state");
              const supp = rsState(hass, d, "supplement");
              const days = rsNum(rsState(hass, d, "remaining_days"));
              const daily = rsNum(rsState(hass, d, "daily_dose"));
              const doses = rsNum(rsState(hass, d, "doses_today"));
              const auto = rsNum(rsState(hass, d, "auto_dosed_today"));
              const manual = rsNum(rsState(hass, d, "manual_dosed_today"));
              const sched = rsState(hass, d, "schedule_enabled");
              const volState = rsState(hass, d, "manual_head_volume");

              let cls = "off";
              let text = "";
              if (off) {
                cls = "bad";
                text = "Unavailable";
              } else if (headState) {
                const v = String(headState.state).toLowerCase();
                if (v === "ok" || v === "on" || v === "enabled" || v === "dosing") {
                  cls = "good";
                  text = v === "dosing" ? "Dosing" : "OK";
                } else {
                  cls = "warn-s";
                  text = humanize(headState.state);
                }
              }
              const big =
                days !== null
                  ? `${Math.round(days)}<span class="unit"> days left</span>`
                  : "";
              const subBits = [];
              if (daily !== null) subBits.push(`${daily.toFixed(1)} mL/day scheduled`);
              if (doses !== null) subBits.push(`today ${Math.round(doses)} doses`);
              const dosedToday = (auto || 0) + (manual || 0);
              if (auto !== null || manual !== null)
                subBits.push(`${dosedToday.toFixed(1)} mL dosed`);
              const warn = off
                ? `<div class="warn">⚠ Unavailable — check the doser's connection</div>`
                : "";

              const buttons = [];
              if (sched)
                buttons.push(
                  `<button class="chip ${sched.state === "on" ? "on" : ""}"
                     data-toggle="${d.entities.schedule_enabled}">Schedule ${sched.state === "on" ? "on" : "off"}</button>`
                );
              if (volState && d.entities.manual_head) {
                const vol = rsNum(volState) || 0;
                const armed = this._armed === d.entities.manual_head;
                buttons.push(`<span class="stepper">
                    <button class="chip" data-step="-1" data-vol="${d.entities.manual_head_volume}">−</button>
                    <span class="vol">${vol.toFixed(1)} mL</span>
                    <button class="chip" data-step="1" data-vol="${d.entities.manual_head_volume}">+</button>
                  </span>`);
                buttons.push(
                  armed
                    ? `<button class="chip armed" data-dose="${d.entities.manual_head}">Tap again — dose ${vol.toFixed(1)} mL</button>`
                    : `<button class="chip go" data-dose="${d.entities.manual_head}">Dose…</button>`
                );
              }
              const suppLine =
                supp && supp.state && supp.state !== "unknown"
                  ? `<div class="supp">${supp.state}</div>`
                  : "";
              return `<div class="drow">
                  <div class="top">
                    <span class="name">${labels[d.id] || d.name}</span>
                    <span class="status ${cls}">${text}</span>
                    <span class="big">${big}</span>
                  </div>
                  ${suppLine}
                  ${subBits.length ? `<div class="sub">${subBits.join(" · ")}</div>` : ""}
                  ${warn}
                  ${buttons.length ? `<div class="buttons">${buttons.join("")}</div>` : ""}
                </div>`;
            })
            .join("")
        : `<div class="empty">No ReefDose heads found. This card needs the
            Red Sea ReefBeat integration (Elwinmage/ha-reefbeat-component)
            with your ReefDose added.</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `<style>${RS_SHARED_CSS}${extra}</style><ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("[data-step]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.vol;
        const st = this._hass.states[id];
        const cur = st ? Number(st.state) || 0 : 0;
        const max = (st && st.attributes.max) || 300;
        const next = Math.min(max, Math.max(0, cur + Number(el.dataset.step)));
        this._hass.callService("number", "set_value", { entity_id: id, value: next });
      });
    });
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.toggle;
        const st = this._hass.states[id];
        this._hass.callService(
          "switch",
          st && st.state === "on" ? "turn_off" : "turn_on",
          { entity_id: id }
        );
      });
    });
    this.shadowRoot.querySelectorAll("[data-dose]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.dose;
        if (this._armed === id) {
          this._armed = null;
          this._hass.callService("button", "press", { entity_id: id });
        } else {
          this._armed = id;
          setTimeout(() => {
            if (this._armed === id) {
              this._armed = null;
              this._render();
            }
          }, 6000);
        }
        this._render();
      });
    });
  }
}

class FeedAndWaterReefDoseCardEditor extends FeedAndWaterRedSeaEditor {
  constructor() {
    super();
    this._roles = DOSE_ROLES;
    this._kind = "ReefDose";
    this._signature = (d) => d.entities.manual_head || d.entities.supplement;
  }
}


// Indexed roles (e.g. a power bar's socket_3_on_off): collect every
// entity of a device whose translation_key (or object_id, as fallback)
// matches the pattern, keyed by the captured index.
function redseaIndexed(hass, deviceId, pattern) {
  const out = {};
  for (const [entityId, entry] of Object.entries(hass.entities || {})) {
    if (entry.platform !== "redsea" || entry.device_id !== deviceId) continue;
    const objectId = entityId.slice(entityId.indexOf(".") + 1);
    const m = (entry.translation_key || "").match(pattern) || objectId.match(pattern);
    if (!m) continue;
    const idx = m[1];
    if (!out[idx]) out[idx] = {};
    out[idx][m[2]] = entityId;
  }
  return out;
}

const RUN_ROLES = {
  type: ["sensor"],
  model: ["sensor"],
  state: ["sensor"],
  temperature: ["sensor"],
  speed: ["number"],
  schedule_enabled: ["switch"],
  sensor_controlled: ["switch"],
};

class FeedAndWaterReefRunCard extends HTMLElement {
  /* ReefRun card: ReefBeat models each ReefRun pump (return / skimmer)
   * as its own HA device — one row each: coloured state, temperature,
   * a full-range speed slider and the schedule toggle. */

  static getConfigElement() {
    return document.createElement("feedandwater-reefrun-card-editor");
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

  _devices() {
    const want =
      this._config.devices && this._config.devices.length
        ? new Set(this._config.devices)
        : null;
    return redseaDevices(this._hass, RUN_ROLES).filter(
      (d) => d.entities.speed && (d.entities.type || d.entities.state) &&
        (!want || want.has(d.id))
    );
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    const labels = this._config.labels || {};
    const extra = `
      .controls { display: flex; align-items: center; gap: 10px; margin-top: 8px;
                  font-size: 0.9em; }
      .controls label { flex: none; color: var(--secondary-text-color); }
      .controls input[type=range] { flex: 1; }
      .controls .val { flex: 0 0 3.5em; text-align: right;
                       color: var(--secondary-text-color); }
    `;

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else {
      const devs = this._devices();
      body = devs.length
        ? devs
            .map((d) => {
              const off = rsUnavailable(hass, d);
              const state = rsState(hass, d, "state");
              const type = rsState(hass, d, "type");
              const model = rsState(hass, d, "model");
              const temp = rsNum(rsState(hass, d, "temperature"));
              const speed = rsState(hass, d, "speed");
              const sched = rsState(hass, d, "schedule_enabled");
              let cls = "off";
              let text = "";
              if (off) {
                cls = "bad";
                text = "Unavailable";
              } else if (state) {
                const v = String(state.state).toLowerCase();
                const good = ["ok", "on", "running", "auto"].includes(v);
                cls = good ? "good" : "warn-s";
                text = good ? "Running" : humanize(state.state);
              }
              const subBits = [];
              if (type && type.state !== "unknown") subBits.push(humanize(type.state));
              if (model && model.state !== "unknown") subBits.push(model.state);
              if (temp !== null) subBits.push(`${temp.toFixed(1)} °C`);
              const warn = off
                ? `<div class="warn">⚠ Unavailable — check the ReefRun's connection</div>`
                : "";
              let slider = "";
              if (speed) {
                const a = speed.attributes;
                const val = rsNum(speed);
                slider = `<div class="controls">
                    <label>Speed</label>
                    <input type="range" min="${a.min != null ? a.min : 0}"
                      max="${a.max != null ? a.max : 100}" step="${a.step != null ? a.step : 1}"
                      value="${val != null ? val : 0}" data-num="${d.entities.speed}">
                    <span class="val">${val != null ? Math.round(val) + "%" : "?"}</span>
                    ${sched ? `<button class="chip ${sched.state === "on" ? "on" : ""}"
                        data-toggle="${d.entities.schedule_enabled}">Schedule ${sched.state === "on" ? "on" : "off"}</button>` : ""}
                  </div>`;
              }
              return `<div class="drow">
                  <div class="top">
                    <span class="name">${labels[d.id] || d.name}</span>
                    <span class="status ${cls}">${text}</span>
                  </div>
                  ${subBits.length ? `<div class="sub">${subBits.join(" · ")}</div>` : ""}
                  ${warn}
                  ${slider}
                </div>`;
            })
            .join("")
        : `<div class="empty">No ReefRun pumps found. This card needs the
            Red Sea ReefBeat integration (Elwinmage/ha-reefbeat-component)
            with your ReefRun added.</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `<style>${RS_SHARED_CSS}${extra}</style><ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("input[data-num]").forEach((el) => {
      el.addEventListener("change", () => {
        this._hass.callService("number", "set_value", {
          entity_id: el.dataset.num,
          value: Number(el.value),
        });
      });
    });
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        const st = this._hass.states[el.dataset.toggle];
        this._hass.callService(
          "switch",
          st && st.state === "on" ? "turn_off" : "turn_on",
          { entity_id: el.dataset.toggle }
        );
      });
    });
  }
}

class FeedAndWaterReefRunCardEditor extends FeedAndWaterRedSeaEditor {
  constructor() {
    super();
    this._roles = RUN_ROLES;
    this._kind = "ReefRun";
    this._signature = (d) => d.entities.speed && (d.entities.type || d.entities.state);
  }
}

const WAVE_ROLES = {
  wave_type: ["sensor"],
  wave_name: ["sensor"],
  wave_direction: ["sensor"],
  wave_forward_intensity: ["sensor", "number"],
  wave_backward_intensity: ["sensor", "number"],
  shortcut_feeding: ["switch"],
};

class FeedAndWaterReefWaveCard extends HTMLElement {
  /* ReefWave card: what each wavemaker is running right now (wave name,
   * type, direction, forward/backward intensity) plus the Feed shortcut
   * toggle to pause it for feeding. */

  static getConfigElement() {
    return document.createElement("feedandwater-reefwave-card-editor");
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

  _devices() {
    const want =
      this._config.devices && this._config.devices.length
        ? new Set(this._config.devices)
        : null;
    return redseaDevices(this._hass, WAVE_ROLES).filter(
      (d) =>
        (d.entities.wave_type || d.entities.shortcut_feeding) &&
        (!want || want.has(d.id))
    );
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    const labels = this._config.labels || {};

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else {
      const devs = this._devices();
      body = devs.length
        ? devs
            .map((d) => {
              const off = rsUnavailable(hass, d);
              const name = rsState(hass, d, "wave_name");
              const type = rsState(hass, d, "wave_type");
              const dir = rsState(hass, d, "wave_direction");
              const fwd = rsNum(rsState(hass, d, "wave_forward_intensity"));
              const back = rsNum(rsState(hass, d, "wave_backward_intensity"));
              const feeding = rsState(hass, d, "shortcut_feeding");
              const feedOn = feeding && feeding.state === "on";
              let cls = "good";
              let text = "";
              if (off) {
                cls = "bad";
                text = "Unavailable";
              } else if (feedOn) {
                cls = "warn-s";
                text = "Feed pause";
              } else {
                const wave =
                  (name && name.state !== "unknown" && name.state) ||
                  (type && type.state !== "unknown" && humanize(type.state)) ||
                  "";
                text = wave ? `Running ${wave}` : "Running";
              }
              const subBits = [];
              if (dir && dir.state !== "unknown") subBits.push(humanize(dir.state));
              if (fwd !== null) subBits.push(`forward ${Math.round(fwd)}%`);
              if (back !== null) subBits.push(`back ${Math.round(back)}%`);
              const warn = off
                ? `<div class="warn">⚠ Unavailable — check the wavemaker's connection</div>`
                : "";
              const buttons = feeding
                ? `<div class="buttons">
                     <button class="chip ${feedOn ? "on" : ""}"
                       data-toggle="${d.entities.shortcut_feeding}">${feedOn ? "Resume waves" : "Feed pause"}</button>
                   </div>`
                : "";
              return `<div class="drow">
                  <div class="top">
                    <span class="name">${labels[d.id] || d.name}</span>
                    <span class="status ${cls}">${text}</span>
                  </div>
                  ${subBits.length ? `<div class="sub">${subBits.join(" · ")}</div>` : ""}
                  ${warn}
                  ${buttons}
                </div>`;
            })
            .join("")
        : `<div class="empty">No ReefWave found. This card needs the Red Sea
            ReefBeat integration (Elwinmage/ha-reefbeat-component) with your
            ReefWave added.</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `<style>${RS_SHARED_CSS}</style><ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        const st = this._hass.states[el.dataset.toggle];
        this._hass.callService(
          "switch",
          st && st.state === "on" ? "turn_off" : "turn_on",
          { entity_id: el.dataset.toggle }
        );
      });
    });
  }
}

class FeedAndWaterReefWaveCardEditor extends FeedAndWaterRedSeaEditor {
  constructor() {
    super();
    this._roles = WAVE_ROLES;
    this._kind = "ReefWave";
    this._signature = (d) => d.entities.wave_type || d.entities.shortcut_feeding;
  }
}

const POWER_ROLES = {
  battery_level: ["sensor"],
  power_temperature: ["sensor"],
  model_type: ["sensor"],
};
const POWER_SOCKET_RE = /^socket_(\d+)_(on_off|state|name)$/;

class FeedAndWaterReefPowerCard extends HTMLElement {
  /* ReefPower card: one row per power bar — battery/temperature at a
   * glance, then a chip per socket (named from the bar's own socket-name
   * sensors) that toggles it. */

  static getConfigElement() {
    return document.createElement("feedandwater-reefpower-card-editor");
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

  _devices() {
    const want =
      this._config.devices && this._config.devices.length
        ? new Set(this._config.devices)
        : null;
    return redseaDevices(this._hass, POWER_ROLES)
      .map((d) => ({ ...d, sockets: redseaIndexed(this._hass, d.id, POWER_SOCKET_RE) }))
      .filter(
        (d) =>
          (d.entities.battery_level || Object.keys(d.sockets).length) &&
          (!want || want.has(d.id))
      );
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    const labels = this._config.labels || {};
    const extra = `
      .sockets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    `;

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else {
      const devs = this._devices();
      body = devs.length
        ? devs
            .map((d) => {
              const off = rsUnavailable(hass, d);
              const battery = rsNum(rsState(hass, d, "battery_level"));
              const temp = rsNum(rsState(hass, d, "power_temperature"));
              const subBits = [];
              if (temp !== null) subBits.push(`${temp.toFixed(1)} °C`);
              if (battery !== null) subBits.push(`battery ${Math.round(battery)}%`);
              let cls = off ? "bad" : "good";
              let text = off ? "Unavailable" : "Online";
              if (!off && battery !== null && battery < 20) {
                cls = "warn-s";
                text = "Battery low";
              }
              const warn = off
                ? `<div class="warn">⚠ Unavailable — check the power bar's connection</div>`
                : "";
              const chips = Object.keys(d.sockets)
                .sort((a, b) => Number(a) - Number(b))
                .map((idx) => {
                  const sock = d.sockets[idx];
                  if (!sock.on_off) return "";
                  const sw = hass.states[sock.on_off];
                  const nameState = sock.name ? hass.states[sock.name] : null;
                  const label =
                    (nameState && nameState.state !== "unknown" && nameState.state) ||
                    `Socket ${Number(idx) + 1}`;
                  const on = sw && sw.state === "on";
                  return `<button class="chip ${on ? "on" : ""}"
                      data-toggle="${sock.on_off}">${label}</button>`;
                })
                .join("");
              return `<div class="drow">
                  <div class="top">
                    <span class="name">${labels[d.id] || d.name}</span>
                    <span class="status ${cls}">${text}</span>
                  </div>
                  ${subBits.length ? `<div class="sub">${subBits.join(" · ")}</div>` : ""}
                  ${warn}
                  ${chips ? `<div class="sockets">${chips}</div>` : ""}
                </div>`;
            })
            .join("")
        : `<div class="empty">No ReefPower found. This card needs the Red Sea
            ReefBeat integration (Elwinmage/ha-reefbeat-component) with your
            ReefPower added.</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `<style>${RS_SHARED_CSS}${extra}</style><ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        const st = this._hass.states[el.dataset.toggle];
        this._hass.callService(
          "switch",
          st && st.state === "on" ? "turn_off" : "turn_on",
          { entity_id: el.dataset.toggle }
        );
      });
    });
  }
}

class FeedAndWaterReefPowerCardEditor extends FeedAndWaterRedSeaEditor {
  constructor() {
    super();
    this._roles = POWER_ROLES;
    this._kind = "ReefPower";
    this._signature = (d) => true;
  }
}

const LED_ROLES = {
  white: ["light"],
  blue: ["light"],
  moon: ["light"],
  kelvin_intensity: ["light"],
  acclimation_remaining_days: ["sensor"],
  moon_day: ["number"],
};
const LED_CHANNELS = [
  ["white", "White"],
  ["blue", "Blue"],
  ["kelvin_intensity", "Kelvin"],
  ["moon", "Moon"],
];

class FeedAndWaterReefLedCard extends HTMLElement {
  /* ReefLED card: compact per-light channel control — a slider per
   * channel (white / blue / kelvin / moon) driving the integration's
   * light entities by brightness, with acclimation and moon-cycle info.
   * Full schedule editing stays in the ReefBeat integration's own
   * tools; this is the day-to-day glance-and-nudge card. */

  static getConfigElement() {
    return document.createElement("feedandwater-reefled-card-editor");
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

  _devices() {
    const want =
      this._config.devices && this._config.devices.length
        ? new Set(this._config.devices)
        : null;
    return redseaDevices(this._hass, LED_ROLES).filter(
      (d) =>
        LED_CHANNELS.some(([role]) => d.entities[role]) &&
        (!want || want.has(d.id))
    );
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const hass = this._hass;
    const labels = this._config.labels || {};
    const extra = `
      .controls { display: flex; align-items: center; gap: 10px; margin-top: 6px;
                  font-size: 0.9em; }
      .controls label { flex: 0 0 4em; color: var(--secondary-text-color); }
      .controls input[type=range] { flex: 1; }
      .controls .val { flex: 0 0 3.2em; text-align: right;
                       color: var(--secondary-text-color); }
    `;

    let body = "";
    if (!hass) {
      body = `<div class="empty">Waiting for Home Assistant…</div>`;
    } else {
      const devs = this._devices();
      body = devs.length
        ? devs
            .map((d) => {
              const off = rsUnavailable(hass, d);
              const accl = rsNum(rsState(hass, d, "acclimation_remaining_days"));
              const moonDay = rsNum(rsState(hass, d, "moon_day"));
              const sliders = LED_CHANNELS.filter(([role]) => d.entities[role])
                .map(([role, label]) => {
                  const st = hass.states[d.entities[role]];
                  const on = st && st.state === "on";
                  const pct =
                    on && st.attributes.brightness != null
                      ? Math.round((st.attributes.brightness / 255) * 100)
                      : on
                        ? 100
                        : 0;
                  return `<div class="controls">
                      <label>${label}</label>
                      <input type="range" min="0" max="100" step="1" value="${pct}"
                        data-light="${d.entities[role]}">
                      <span class="val">${pct}%</span>
                    </div>`;
                })
                .join("");
              const anyOn = LED_CHANNELS.some(([role]) => {
                const st = d.entities[role] && hass.states[d.entities[role]];
                return st && st.state === "on";
              });
              let cls = off ? "bad" : anyOn ? "good" : "off";
              let text = off ? "Unavailable" : anyOn ? "On" : "Off";
              const subBits = [];
              if (accl !== null && accl > 0)
                subBits.push(`acclimation: ${Math.round(accl)} days left`);
              if (moonDay !== null) subBits.push(`moon day ${Math.round(moonDay)}`);
              const warn = off
                ? `<div class="warn">⚠ Unavailable — check the light's connection</div>`
                : "";
              return `<div class="drow">
                  <div class="top">
                    <span class="name">${labels[d.id] || d.name}</span>
                    <span class="status ${cls}">${text}</span>
                  </div>
                  ${subBits.length ? `<div class="sub">${subBits.join(" · ")}</div>` : ""}
                  ${warn}
                  ${sliders}
                </div>`;
            })
            .join("")
        : `<div class="empty">No ReefLED found. This card needs the Red Sea
            ReefBeat integration (Elwinmage/ha-reefbeat-component) with your
            ReefLED added.</div>`;
    }

    const heading = this._config.title
      ? `<div class="heading">${this._config.title}</div>`
      : "";
    this.shadowRoot.innerHTML = `<style>${RS_SHARED_CSS}${extra}</style><ha-card>${heading}${body}</ha-card>`;

    this.shadowRoot.querySelectorAll("input[data-light]").forEach((el) => {
      el.addEventListener("change", () => {
        const id = el.dataset.light;
        const pct = Number(el.value);
        if (pct <= 0) {
          this._hass.callService("light", "turn_off", { entity_id: id });
        } else {
          this._hass.callService("light", "turn_on", {
            entity_id: id,
            brightness_pct: pct,
          });
        }
      });
    });
  }
}

class FeedAndWaterReefLedCardEditor extends FeedAndWaterRedSeaEditor {
  constructor() {
    super();
    this._roles = LED_ROLES;
    this._kind = "ReefLED";
    this._signature = (d) => LED_CHANNELS.some(([role]) => d.entities[role]);
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
customElements.define("feedandwater-equipment-card", FeedAndWaterEquipmentCard);
customElements.define("feedandwater-reefmat-card", FeedAndWaterReefMatCard);
customElements.define(
  "feedandwater-reefmat-card-editor",
  FeedAndWaterReefMatCardEditor
);
customElements.define("feedandwater-reefato-card", FeedAndWaterReefAtoCard);
customElements.define("feedandwater-reefdose-card", FeedAndWaterReefDoseCard);
customElements.define("feedandwater-reefrun-card", FeedAndWaterReefRunCard);
customElements.define(
  "feedandwater-reefrun-card-editor",
  FeedAndWaterReefRunCardEditor
);
customElements.define("feedandwater-reefwave-card", FeedAndWaterReefWaveCard);
customElements.define(
  "feedandwater-reefwave-card-editor",
  FeedAndWaterReefWaveCardEditor
);
customElements.define("feedandwater-reefpower-card", FeedAndWaterReefPowerCard);
customElements.define(
  "feedandwater-reefpower-card-editor",
  FeedAndWaterReefPowerCardEditor
);
customElements.define("feedandwater-reefled-card", FeedAndWaterReefLedCard);
customElements.define(
  "feedandwater-reefled-card-editor",
  FeedAndWaterReefLedCardEditor
);
customElements.define(
  "feedandwater-reefdose-card-editor",
  FeedAndWaterReefDoseCardEditor
);
customElements.define(
  "feedandwater-reefato-card-editor",
  FeedAndWaterReefAtoCardEditor
);
customElements.define(
  "feedandwater-equipment-card-editor",
  FeedAndWaterEquipmentCardEditor
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
    type: "feedandwater-reefmat-card",
    name: "Reef Feed & Water — ReefMat",
    description:
      "Fleece roll status for RedSea ReefMats (via the ReefBeat integration): days left, usage, dirty-sensor warning, Advance and a two-tap New Roll.",
  },
  {
    type: "feedandwater-reefato-card",
    name: "Reef Feed & Water — ReefATO+",
    description:
      "RedSea ReefATO+ control (via the ReefBeat integration): water level, reservoir days left, today's fills, leak alarm, Fill/Stop/Resume and the Auto fill toggle.",
  },
  {
    type: "feedandwater-reefdose-card",
    name: "Reef Feed & Water — ReefDose",
    description:
      "RedSea ReefDose heads (via the ReefBeat integration): supplement, container days left, today's dosing, schedule toggle, and a guarded manual dose with -/+ volume steppers.",
  },
  {
    type: "feedandwater-reefrun-card",
    name: "Reef Feed & Water — ReefRun",
    description:
      "RedSea ReefRun pumps (via the ReefBeat integration): per-pump state, temperature, full-range speed slider and schedule toggle.",
  },
  {
    type: "feedandwater-reefwave-card",
    name: "Reef Feed & Water — ReefWave",
    description:
      "RedSea ReefWave wavemakers (via the ReefBeat integration): current wave, direction and intensities, with a one-tap Feed pause.",
  },
  {
    type: "feedandwater-reefpower-card",
    name: "Reef Feed & Water — ReefPower",
    description:
      "RedSea ReefPower bars (via the ReefBeat integration): battery and temperature at a glance, plus a named toggle chip per socket.",
  },
  {
    type: "feedandwater-reefled-card",
    name: "Reef Feed & Water — ReefLED",
    description:
      "RedSea ReefLED lights (via the ReefBeat integration): per-channel sliders (white/blue/kelvin/moon), acclimation and moon-cycle info.",
  },
  {
    type: "feedandwater-equipment-card",
    name: "Reef Feed & Water — Equipment status",
    description:
      "Live status for dosers, ATO, heaters, probes — anything. Coloured Running/Off/Problem/OK status, readings with units, time in that state, On/Off buttons, and red Unavailable for gear that dropped off the network.",
  },
  {
    type: "feedandwater-maintenance-card",
    name: "Reef Feed & Water — Maintenance",
    description:
      "Repeatable mark-it-done tasks (fleece roll, ATO reset…) with time-since counters, live equipment status, and a Done button that fires the linked action.",
  }
);
