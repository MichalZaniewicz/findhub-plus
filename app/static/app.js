"use strict";

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch("/api/" + path, { credentials: "same-origin", headers, ...opts });
  if (res.status === 401 && !path.startsWith("auth/")) {
    showLogin();
    throw new Error(t("error.sessionExpired"));
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : (body.detail?.[0]?.msg || detail);
    } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return (res.headers.get("content-type") || "").includes("json") ? res.json() : res.text();
}

let toastTimer;
function toast(msg, ms = 4000) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

const fmtAcc = (a) => (a ? `±${a >= 1000 ? (a / 1000).toFixed(1) + " km" : Math.round(a) + " m"}` : "");
const fmtKm = (m) => `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;

function reportLabel(p) {
  if (p.lat == null) return `📍 ${p.semantic_name || t("report.place")}`;
  if (p.is_own_report) return t("report.own");
  const status = p.status ?? p.loc_status;
  return t({ 0: "report.semantic", 1: "report.lastKnown", 2: "report.network", 3: "report.aggregated" }[status] || "report.other");
}
function kindLabel(d) {
  const key = d.kind === "android" ? "phone" : d.device_type || "beacon";
  return tOr(`kind.${key}`, d.device_type || t("kind.beacon"));
}
const deviceName = (d) => d.custom_name || d.name;
/** Poll errors come from the server as "code:<name>[:arg]" (translated here) or as raw text. */
function errorText(err) {
  if (!err || !err.startsWith("code:")) return err;
  const [, code, arg] = err.split(":");
  return tOr(`deviceError.${code}`, err, { s: arg });
}
const deviceById = (id) => state.devices.find((d) => d.id === id);

function haversine(a, b) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Same rule as the server: ignore jitter that fits inside the measurement accuracy.
function trackDistance(pts) {
  const usable = pts.filter((p) => p.accuracy == null || p.accuracy <= 300);
  let sum = 0;
  for (let i = 1; i < usable.length; i++) {
    const d = haversine(usable[i - 1], usable[i]);
    const noise = Math.max(30, ((usable[i - 1].accuracy || 0) + (usable[i].accuracy || 0)) / 2);
    if (d > noise) sum += d;
  }
  return sum;
}

/* ---------- icons (Lucide, ISC license) ---------- */
const ICONS = {
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  settings: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  zones: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  play: '<polygon points="7 4 19 12 7 20 7 4" fill="currentColor"/>',
  pause: '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  locate: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
  alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldAlert: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  enter: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>',
  exit: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  tag: '<path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.41 0l8.59-8.59a1 1 0 0 0 0-1.41Z"/><circle cx="7" cy="7" r="1.5"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  bike: '<circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  bag: '<path d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M8 10h8"/><path d="M8 18h8"/><path d="M8 22v-6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  watch: '<circle cx="12" cy="12" r="6"/><polyline points="12 10 12 12 13 13"/><path d="m16.13 7.66-.81-4.05a2 2 0 0 0-2-1.61h-2.68a2 2 0 0 0-2 1.61l-.78 4.05"/><path d="m7.88 16.36.8 4a2 2 0 0 0 2 1.61h2.72a2 2 0 0 0 2-1.61l.81-4.05"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  paw: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
};
const icon = (name, size = 18) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.tag}</svg>`;
const KIND_ICON = {
  phone: "phone", keys: "key", bike: "bike", car: "car", bag: "bag", wallet: "wallet", headphones: "headphones",
  watch: "watch", laptop: "laptop", dog: "paw", cat: "paw", camera: "camera",
};
const kindIcon = (d) => KIND_ICON[d.kind === "android" ? "phone" : d.device_type] || "tag";
const isFresh = (ts) => ts && Date.now() - new Date(ts).getTime() < 15 * 60e3;

function injectIcons(root = document) {
  root.querySelectorAll("[data-icon]:not([data-icon-done])").forEach((el) => {
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon));
    el.dataset.iconDone = "1";
  });
}
const setPlayIcon = (btn, playing) => { btn.innerHTML = icon(playing ? "pause" : "play", 16); };

function pinIcon(d, size = 36, count = 1) {
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size + 4],
    popupAnchor: [0, -size],
    tooltipAnchor: [size / 2, -size / 2 - 4],
    html: `<div class="pin">${isFresh(d.loc_ts) ? `<span class="pin-pulse" style="background:${esc(d.color)}"></span>` : ""}
      <span class="pin-body" style="background:${esc(d.color)}"></span>
      <span class="pin-icon">${icon(kindIcon(d), 16)}</span>${count > 1 ? `<span class="pin-count">${count}</span>` : ""}</div>`,
  });
}

/** fitBounds that keeps the floating panels from covering the points. */
function fitTo(latlngs, maxZoom = 16) {
  if (!latlngs.length) return;
  if (window.innerWidth <= 800) {
    const sheet = $("#sidebar").getBoundingClientRect().height;
    map.fitBounds(latlngs, { paddingTopLeft: [30, 90], paddingBottomRight: [30, Math.round(sheet) + 20], maxZoom });
  } else {
    const side = $(".sidebar").getBoundingClientRect();
    map.fitBounds(latlngs, { paddingTopLeft: [side.right + 40, 100], paddingBottomRight: [70, 50], maxZoom });
  }
}

/* ---------- state ---------- */
const state = {
  devices: [],
  zones: [],
  status: null,
  panel: "devices",
  selectedId: null,
  history: [],
  tab: "route",
  fitted: false,
  playIndex: 0,
  playTimer: null,
  lastEventId: null,
  compare: { ids: null, data: {}, tmin: 0, tmax: 0, timer: null },
  zoneDraft: null,
};

/* ---------- map ---------- */
let map, zonesLayer, overviewLayer, historyLayer, heatLayer, playLayer, staysLayer, compareLayer, draftLayer, focusLayer;

function initMap() {
  map = L.map("map", { zoomControl: false }).setView([52.1, 19.4], 6);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap",
  });
  // Dark variant: the same OSM tiles recoloured with a CSS filter (no API key needed).
  const dark = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap", className: "tiles-dark",
  });
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "&copy; Esri",
  });
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  (prefersDark ? dark : osm).addTo(map);
  L.control.layers({ Map: osm, Dark: dark, Satellite: sat }, null, { position: "topright" }).addTo(map);
  // Zone labels live in their own pane under markers and device labels.
  map.createPane("zoneLabels").style.zIndex = 450;
  zonesLayer = L.layerGroup().addTo(map);
  overviewLayer = L.layerGroup().addTo(map);
  heatLayer = L.layerGroup().addTo(map);
  historyLayer = L.layerGroup().addTo(map);
  staysLayer = L.layerGroup().addTo(map);
  playLayer = L.layerGroup().addTo(map);
  compareLayer = L.layerGroup().addTo(map);
  draftLayer = L.layerGroup().addTo(map);
  focusLayer = L.layerGroup().addTo(map);
  map.on("click", onMapClick);
  map.on("zoomend", () => renderOverview());
}

/* ---------- panels ---------- */
function showPanel(name) {
  state.panel = name;
  for (const p of ["devices", "history", "compare", "zones"]) $(`#${p}-panel`).hidden = p !== name;
  if (name !== "history") {
    stopPlay();
    state.selectedId = null;
    for (const l of [historyLayer, heatLayer, playLayer, staysLayer]) l.clearLayers();
  }
  if (name !== "compare") { stopCompare(); compareLayer.clearLayers(); }
  if (name !== "zones") closeZoneForm();
  focusLayer.clearLayers();
  renderOverview();
}
$$("[data-back]").forEach((b) => b.addEventListener("click", () => showPanel("devices")));

/* ---------- zones on map ---------- */
function renderZonesLayer() {
  zonesLayer.clearLayers();
  for (const z of state.zones) {
    if (state.zoneDraft?.id === z.id) continue;
    L.circle([z.lat, z.lon], { radius: z.radius, color: z.color, weight: 2, dashArray: "6 6", fillOpacity: 0.06, interactive: false })
      .addTo(zonesLayer);
    // Label on the top edge of the circle, so it does not cover device pins in the middle.
    L.marker([z.lat + z.radius / 111320, z.lon], { opacity: 0, interactive: false, keyboard: false })
      .bindTooltip(esc(z.name), { permanent: true, direction: "center", className: "zone-label", pane: "zoneLabels" })
      .addTo(zonesLayer);
  }
}

/* ---------- overview ---------- */
function renderOverview() {
  overviewLayer.clearLayers();
  if (state.panel !== "devices" && state.panel !== "zones") return;
  const showHidden = $("#show-hidden").checked;
  const visible = state.devices.filter((d) => d.lat != null && (!d.hidden || showHidden));
  const bounds = visible.map((d) => [d.lat, d.lon]);
  for (const d of visible) {
    if (d.accuracy) L.circle([d.lat, d.lon], { radius: d.accuracy, color: d.color, weight: 1, fillOpacity: 0.08, interactive: false }).addTo(overviewLayer);
  }
  // Pins closer than ~40 px on screen are merged into one pin with a counter (they split when zooming in).
  for (const group of clusterOnScreen(visible, 40)) {
    const lead = group.reduce((a, b) => (new Date(b.loc_ts) > new Date(a.loc_ts) ? b : a));
    const names = group.map(deviceName);
    const label = names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
    L.marker([lead.lat, lead.lon], { icon: pinIcon(lead, 36, group.length), riseOnHover: true })
      .bindTooltip(esc(label), { permanent: true, direction: "right", offset: [4, 0], className: "marker-label" })
      .bindPopup(group.map(devicePopupRow).join('<hr class="popup-sep">'), { minWidth: 220 })
      .on("dblclick", () => group.length === 1 && selectDevice(lead.id))
      .addTo(overviewLayer);
  }
  if (!state.fitted && bounds.length) {
    fitTo(bounds);
    state.fitted = true;
  }
}

function clusterOnScreen(devices, px) {
  const groups = [];
  for (const d of devices) {
    const p = map.latLngToContainerPoint([d.lat, d.lon]);
    const g = groups.find((x) => x.p.distanceTo(p) < px);
    if (g) g.items.push(d); else groups.push({ p, items: [d] });
  }
  return groups.map((g) => g.items);
}

function devicePopupRow(d) {
  return `<div class="popup-device">
      <div class="popup-title"><span class="device-color" style="background:${esc(d.color)}"></span><b>${esc(deviceName(d))}</b></div>
      <div class="muted small">${fmtDateTime(d.loc_ts)} · ${relTime(d.loc_ts)}<br>${fmtAcc(d.accuracy)} · ${esc(reportLabel(d))}</div>
      <div class="popup-actions">
        <button class="btn btn-sm" data-popup-act="history" data-id="${esc(d.id)}">${icon("route", 14)}${esc(t("devices.history"))}</button>
        <button class="btn btn-sm" data-popup-act="locate" data-id="${esc(d.id)}">${icon("locate", 14)}<span>${esc(t("devices.locate"))}</span></button>
      </div>
    </div>`;
}

// Leaflet stops click propagation inside popups, so listen in the capture phase.
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-popup-act]");
  if (!btn) return;
  ev.stopPropagation();
  const id = btn.dataset.id;
  if (btn.dataset.popupAct === "history") { map.closePopup(); selectDevice(id); }
  if (btn.dataset.popupAct === "locate") locateDevice(id, btn);
}, true);

/* ---------- device list ---------- */
function zonesOf(deviceId) {
  return state.zones.filter((z) => (z.devices || []).includes(deviceId)).map((z) => z.name);
}

function actionButton(act, iconName, label, on = false) {
  return `<button class="action ${on ? "on" : ""}" data-act="${act}" title="${esc(label)}">${icon(iconName, 17)}<span>${esc(label)}</span></button>`;
}

function deviceNotice(d) {
  if (!d.last_error) return "";
  const code = d.last_error.startsWith("code:") ? d.last_error.split(":")[1] : null;
  // "No reports" / "no response" is normal for tags out of reach of phones: show it calmly.
  if (code === "no_reports" || code === "timeout") {
    const text = d.points ? errorText(d.last_error) : t("devices.waitingFirst");
    return `<div class="device-note">${icon("info", 14)}<span>${esc(text)}</span></div>`;
  }
  return `<div class="device-error">${icon("alert", 14)}<span>${esc(errorText(d.last_error))}</span></div>`;
}

function renderDevices() {
  const list = $("#device-list");
  const showHidden = $("#show-hidden").checked;
  const visible = state.devices.filter((d) => showHidden || !d.hidden);
  $("#devices-empty").hidden = visible.length > 0;
  list.innerHTML = visible.map((d) => {
    const where = d.lat != null
      ? `${relTime(d.loc_ts)} · ${fmtAcc(d.accuracy)} · ${esc(reportLabel(d))}`
      : esc(t("devices.noLocation"));
    const sem = d.semantic_name && (!d.loc_ts || new Date(d.sem_ts) > new Date(d.loc_ts))
      ? `<div class="device-meta">📍 ${esc(d.semantic_name)} · ${relTime(d.sem_ts)}</div>` : "";
    const inZones = zonesOf(d.id);
    const badges = [
      inZones.length ? `<span class="tag-badge">${icon("zones", 12)} ${esc(inZones.join(", "))}</span>` : "",
      d.guard_enabled ? `<span class="tag-badge warn">${icon("shield", 12)} ${esc(t("devices.guarded"))}</span>` : "",
      d.lost_after_hours ? `<span class="tag-badge">${icon("alarm", 12)} ${Math.round(d.lost_after_hours)} h</span>` : "",
    ].join("");
    return `
      <li class="device ${d.hidden ? "is-hidden" : ""}" data-id="${esc(d.id)}">
        <div class="device-top">
          <span class="avatar" style="background:${esc(d.color)};color:${esc(d.color)}">${icon(kindIcon(d), 19)}</span>
          <div class="device-title">
            <span class="device-name">${esc(deviceName(d))}</span>
            <span class="device-sub">${isFresh(d.loc_ts) ? '<span class="live-dot"></span>' : ""}${where}</span>
          </div>
          <span class="device-kind">${esc(kindLabel(d))}</span>
        </div>
        ${sem}
        ${d.points ? `<div class="device-meta">${esc(tp("count.points", d.points))}${d.tracking ? "" : " · " + esc(t("devices.notTracked"))}</div>` : ""}
        ${badges ? `<div class="device-badges">${badges}</div>` : ""}
        ${deviceNotice(d)}
        <div class="device-actions">
          ${actionButton("history", "route", t("devices.history"))}
          ${actionButton("locate", "locate", t("devices.locate"))}
          ${actionButton("sound", ringing.has(d.id) ? "mute" : "sound", t(ringing.has(d.id) ? "devices.stopSound" : "devices.sound"), ringing.has(d.id))}
          ${actionButton("alarms", "alarm", t("devices.alarms"), !!(d.guard_enabled || d.lost_after_hours))}
        </div>
      </li>`;
  }).join("");
}

$("#device-list").addEventListener("click", async (ev) => {
  const li = ev.target.closest(".device");
  if (!li) return;
  const id = li.dataset.id;
  const act = ev.target.closest("[data-act]")?.dataset.act;
  if (act === "locate") return locateDevice(id, ev.target);
  if (act === "sound") return toggleSound(id, ev.target);
  if (act === "history") return selectDevice(id);
  if (act === "alarms") return openAlarms(id);
  const d = deviceById(id);
  if (d?.lat != null) map.setView([d.lat, d.lon], Math.max(map.getZoom(), 15));
});

async function locateDevice(id, btn) {
  btn = btn.closest("button");
  const label = btn.querySelector("span");
  btn.classList.add("busy");
  btn.disabled = true;
  if (label) label.textContent = t("devices.locating");
  try {
    const res = await api(`devices/${enc(id)}/locate`, { method: "POST" });
    toast(res.error ? `⚠ ${errorText(res.error)}` : res.new_points ? tp("toast.newPoints", res.new_points) : t("toast.noNewPosition"));
    await refreshDevices();
    if (state.selectedId === id) await loadHistory();
  } catch (e) {
    toast(t("error.generic", { msg: e.message }));
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
    if (label) label.textContent = t("devices.locate");
  }
}

const ringing = new Set();
async function toggleSound(id, btn) {
  const start = !ringing.has(id);
  try {
    await api(`devices/${enc(id)}/sound`, { method: "POST", body: JSON.stringify({ start }) });
    if (start) {
      ringing.add(id);
      toast(t("toast.soundSent"));
      setTimeout(() => { ringing.delete(id); renderDevices(); }, 30000);
    } else {
      ringing.delete(id);
    }
    renderDevices();
  } catch (e) {
    toast(t("error.generic", { msg: e.message }));
  }
}

$("#show-hidden").addEventListener("change", () => { renderDevices(); renderOverview(); });

/* ---------- time ranges ---------- */
const RANGE_KEYS = ["6h", "24h", "7d", "30d", "custom"];
const RANGE_HOURS = { "6h": 6, "24h": 24, "7d": 168, "30d": 720 };

function createRange(key, onChange) {
  const box = $(`[data-range-for=${key}]`);
  const custom = $(`[data-custom-for=${key}]`);
  const range = {
    value: "24h",
    bounds() {
      const now = new Date();
      if (RANGE_HOURS[this.value]) return [new Date(now - RANGE_HOURS[this.value] * 3600e3), now];
      const from = $("[data-range-from]", custom).value;
      const to = $("[data-range-to]", custom).value;
      return [from ? new Date(from) : new Date(now - 24 * 3600e3), to ? new Date(to) : now];
    },
    query(extra = {}) {
      const [from, to] = this.bounds();
      const q = new URLSearchParams({ start: from.toISOString(), end: to.toISOString() });
      for (const [k, v] of Object.entries(extra)) if (v !== "" && v != null) q.set(k, v);
      return q.toString();
    },
    render() {
      box.innerHTML = RANGE_KEYS.map((v) =>
        `<button data-range="${v}" class="${v === this.value ? "active" : ""}">${esc(t(`range.${v}`))}</button>`).join("");
    },
    get live() { return this.value !== "custom"; },
  };
  box.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-range]");
    if (!btn) return;
    range.value = btn.dataset.range;
    range.render();
    custom.hidden = range.value !== "custom";
    if (range.value === "custom") {
      const toLocal = (d) => new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
      const from = $("[data-range-from]", custom), to = $("[data-range-to]", custom);
      if (!from.value) from.value = toLocal(new Date(Date.now() - 24 * 3600e3));
      if (!to.value) to.value = toLocal(new Date());
      return;
    }
    onChange(true);
  });
  $("[data-range-apply]", custom).addEventListener("click", () => onChange(true));
  range.render();
  return range;
}

const historyRange = createRange("history", (fit) => loadHistory(fit));
const compareRange = createRange("compare", () => loadCompare(true));

/* ---------- history ---------- */
function selectDevice(id) {
  showPanel("history");
  setSheet("half");
  state.selectedId = id;
  const d = deviceById(id);
  $("#history-title").textContent = d ? deviceName(d) : id;
  overviewLayer.clearLayers();
  loadHistory(true);
}

function setTab(tab) {
  state.tab = tab;
  $$("#history-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$("[data-tab-panel]").forEach((p) => (p.hidden = p.dataset.tabPanel !== tab));
  staysLayer.clearLayers();
  if (tab === "stays") loadStays();
  if (tab === "days") loadDays();
}
$("#history-tabs").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-tab]");
  if (b) setTab(b.dataset.tab);
});

async function loadHistory(fit = false) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const q = historyRange.query({ max_accuracy: $("#accuracy-filter").value });
  const rows = await api(`devices/${enc(id)}/history?${q}`);
  if (state.selectedId !== id) return;
  state.history = rows;
  for (const fmt of ["gpx", "csv", "geojson"]) $(`#export-${fmt}`).href = `/api/devices/${enc(id)}/export.${fmt}?${q}`;
  renderHistory(fit);
  if (state.tab === "stays") loadStays();
  if (state.tab === "days") loadDays();
}

const geoPoints = () => state.history.filter((p) => p.lat != null);
const selectedColor = () => deviceById(state.selectedId)?.color || "#2563eb";

function renderHistory(fit) {
  stopPlay();
  historyLayer.clearLayers();
  heatLayer.clearLayers();
  playLayer.clearLayers();
  const color = selectedColor();
  const pts = geoPoints();
  const latlngs = pts.map((p) => [p.lat, p.lon]);

  if ($("#show-heat").checked && pts.length && L.heatLayer) {
    L.heatLayer(pts.filter((p) => (p.accuracy || 0) <= 300).map((p) => [p.lat, p.lon, 0.6]), { radius: 25, blur: 20, maxZoom: 17 })
      .addTo(heatLayer);
  }
  if ($("#show-line").checked && latlngs.length > 1) {
    L.polyline(latlngs, { color, weight: 3, opacity: 0.75 }).addTo(historyLayer);
  }
  if ($("#show-points").checked) {
    pts.forEach((p, i) => {
      const last = i === pts.length - 1;
      L.circleMarker([p.lat, p.lon], {
        radius: last ? 8 : 4, color: last ? "#fff" : color, weight: last ? 2 : 1, fillColor: color, fillOpacity: last ? 1 : 0.6,
      })
        .bindPopup(`<b>${fmtDateTime(p.ts)}</b><br>${fmtAcc(p.accuracy)} · ${esc(reportLabel(p))}`)
        .on("click", () => setPlayIndex(i))
        .addTo(historyLayer);
    });
  }
  if (pts.length) {
    const lastP = pts[pts.length - 1];
    if (lastP.accuracy) L.circle([lastP.lat, lastP.lon], { radius: lastP.accuracy, color, weight: 1, fillOpacity: 0.08, interactive: false }).addTo(historyLayer);
  }
  if (fit && latlngs.length) fitTo(latlngs, 17);

  const dist = trackDistance(pts);
  const span = pts.length > 1 ? (new Date(pts[pts.length - 1].ts) - new Date(pts[0].ts)) / 1000 : 0;
  $("#history-stats").innerHTML = `
    <div class="stat"><b>${pts.length}</b><span>${esc(tp("unit.points", pts.length))}</span></div>
    <div class="stat"><b>${fmtKm(dist)}</b><span>${esc(t("history.distance"))}</span></div>
    <div class="stat"><b>${esc(fmtDuration(span))}</b><span>${esc(t("history.span"))}</span></div>`;

  const slider = $("#play-slider");
  slider.max = Math.max(0, pts.length - 1);
  slider.disabled = pts.length < 2;
  $("#play-btn").disabled = pts.length < 2;
  setPlayIndex(Math.max(0, pts.length - 1), false);

  const rows = state.history.slice(-300).reverse();
  $("#point-list").innerHTML = rows.length
    ? rows.map((p) => `<li data-ts="${esc(p.ts)}"><span>${fmtDateTime(p.ts)}</span><span class="tag">${fmtAcc(p.accuracy)} ${esc(reportLabel(p))}</span></li>`).join("")
    : `<li class="muted">${esc(t("history.empty"))}</li>`;
}

$("#point-list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-ts]");
  if (!li) return;
  const i = geoPoints().findIndex((p) => p.ts === li.dataset.ts);
  if (i >= 0) setPlayIndex(i);
});
$("#accuracy-filter").addEventListener("change", () => loadHistory(false));
for (const id of ["#show-points", "#show-line", "#show-heat"]) $(id).addEventListener("change", () => renderHistory(false));

/* ---------- stays & days ---------- */
async function loadStays() {
  const id = state.selectedId;
  const list = $("#stay-list");
  list.innerHTML = `<li class="muted">${esc(t("common.loading"))}</li>`;
  const stays = await api(`devices/${enc(id)}/stays?${historyRange.query()}`);
  if (state.selectedId !== id || state.tab !== "stays") return;
  staysLayer.clearLayers();
  const color = selectedColor();
  stays.forEach((s, i) => {
    L.circleMarker([s.lat, s.lon], { radius: 13, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.85 })
      .bindTooltip(String(i + 1), { permanent: true, direction: "center", className: "stay-number" })
      .bindPopup(`<b>${esc(s.zone || t("stays.place"))}</b><br>${fmtDateTime(s.start)} – ${fmtDateTime(s.end)}<br>${esc(fmtDuration(s.duration_s))}`)
      .addTo(staysLayer);
  });
  list.innerHTML = stays.length ? stays.map((s, i) => `
    <li data-lat="${s.lat}" data-lon="${s.lon}">
      <span class="stay-num" style="background:${esc(color)}">${i + 1}</span>
      <div class="grow">
        <b>${esc(s.zone || `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`)}</b>
        <div class="muted small">${fmtDateTime(s.start)} – ${fmtTime(s.end)}</div>
      </div>
      <b class="nowrap">${esc(fmtDuration(s.duration_s))}</b>
    </li>`).join("") : `<li class="muted">${esc(t("stays.empty"))}</li>`;
}
$("#stay-list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-lat]");
  if (li) map.setView([+li.dataset.lat, +li.dataset.lon], 17);
});

async function loadDays() {
  const id = state.selectedId;
  const body = $("#daily-table tbody");
  body.innerHTML = `<tr><td colspan="5" class="muted">${esc(t("common.loading"))}</td></tr>`;
  const days = await api(`devices/${enc(id)}/daily?${historyRange.query()}`);
  if (state.selectedId !== id || state.tab !== "days") return;
  body.innerHTML = days.length ? days.slice().reverse().map((d) => `
    <tr>
      <td class="nowrap">${fmtDate(d.date + "T12:00:00")}</td>
      <td>${d.points}</td>
      <td class="nowrap">${fmtKm(d.distance_m)}</td>
      <td>${d.stays}</td>
      <td class="nowrap">${fmtTime(d.first)}–${fmtTime(d.last)}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="muted">${esc(t("history.empty"))}</td></tr>`;
}

/* ---------- route playback ---------- */
function setPlayIndex(i, pan = true) {
  const pts = geoPoints();
  playLayer.clearLayers();
  if (!pts.length) { $("#play-label").textContent = ""; return; }
  i = Math.min(Math.max(0, i), pts.length - 1);
  state.playIndex = i;
  $("#play-slider").value = i;
  const color = selectedColor();
  const p = pts[i];
  if (i > 0) L.polyline(pts.slice(0, i + 1).map((q) => [q.lat, q.lon]), { color, weight: 6, opacity: 0.9 }).addTo(playLayer);
  L.circleMarker([p.lat, p.lon], { radius: 10, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 }).addTo(playLayer);
  $("#play-label").textContent = `${i + 1}/${pts.length} · ${fmtDateTime(p.ts)} · ${fmtAcc(p.accuracy)} · ${reportLabel(p)}`;
  if (pan && !map.getBounds().pad(-0.15).contains([p.lat, p.lon])) map.panTo([p.lat, p.lon]);
}

function stopPlay() {
  clearInterval(state.playTimer);
  state.playTimer = null;
  setPlayIcon($("#play-btn"), false);
}

function togglePlay() {
  if (state.playTimer) return stopPlay();
  const pts = geoPoints();
  if (pts.length < 2) return;
  if (state.playIndex >= pts.length - 1) setPlayIndex(0);
  setPlayIcon($("#play-btn"), true);
  const speed = parseFloat($("#play-speed").value);
  state.playTimer = setInterval(() => {
    if (state.playIndex >= geoPoints().length - 1) return stopPlay();
    setPlayIndex(state.playIndex + 1);
  }, 700 / speed);
}
$("#play-btn").addEventListener("click", togglePlay);
$("#play-slider").addEventListener("input", (e) => { stopPlay(); setPlayIndex(parseInt(e.target.value, 10)); });
$("#play-speed").addEventListener("change", () => { if (state.playTimer) { stopPlay(); togglePlay(); } });

/* ---------- compare ---------- */
function openCompare() {
  showPanel("compare");
  if (!state.compare.ids) {
    state.compare.ids = new Set(state.devices.filter((d) => d.lat != null && !d.hidden).map((d) => d.id));
  }
  renderCompareList();
  loadCompare(true);
}
$("#btn-compare").addEventListener("click", openCompare);

function renderCompareList() {
  $("#compare-devices").innerHTML = state.devices.map((d) => `
    <li><label class="check">
      <input type="checkbox" value="${esc(d.id)}" ${state.compare.ids.has(d.id) ? "checked" : ""}>
      <span class="device-color" style="background:${esc(d.color)}"></span>
      <span class="grow">${esc(deviceName(d))}</span>
      <span class="muted small" data-cmp-count="${esc(d.id)}"></span>
    </label></li>`).join("");
}
$("#compare-devices").addEventListener("change", (ev) => {
  const box = ev.target.closest("input[type=checkbox]");
  if (!box) return;
  if (box.checked) state.compare.ids.add(box.value); else state.compare.ids.delete(box.value);
  loadCompare(false);
});

async function loadCompare(fit) {
  stopCompare();
  const ids = [...state.compare.ids];
  const q = compareRange.query({ max_accuracy: 300 });
  const results = await Promise.all(ids.map((id) => api(`devices/${enc(id)}/history?${q}`).catch(() => [])));
  if (state.panel !== "compare") return;
  state.compare.data = {};
  let tmin = Infinity, tmax = -Infinity;
  ids.forEach((id, i) => {
    const pts = results[i].filter((p) => p.lat != null).map((p) => ({ ...p, t: new Date(p.ts).getTime() }));
    state.compare.data[id] = pts;
    if (pts.length) { tmin = Math.min(tmin, pts[0].t); tmax = Math.max(tmax, pts[pts.length - 1].t); }
    const cnt = $(`[data-cmp-count="${CSS.escape(id)}"]`);
    if (cnt) cnt.textContent = String(pts.length);
  });
  state.compare.tmin = tmin;
  state.compare.tmax = tmax;
  const all = Object.values(state.compare.data).flat().map((p) => [p.lat, p.lon]);
  if (fit && all.length) fitTo(all);
  setCompareT(1000);
}

function setCompareT(v) {
  compareLayer.clearLayers();
  const c = state.compare;
  $("#cmp-slider").value = v;
  if (!isFinite(c.tmin)) { $("#cmp-label").textContent = t("history.empty"); return; }
  const time = c.tmin + (c.tmax - c.tmin) * (v / 1000);
  for (const [id, pts] of Object.entries(c.data)) {
    if (!pts.length) continue;
    const color = deviceById(id)?.color || "#2563eb";
    L.polyline(pts.map((p) => [p.lat, p.lon]), { color, weight: 2, opacity: 0.35, interactive: false }).addTo(compareLayer);
    let idx = -1;
    for (let i = 0; i < pts.length && pts[i].t <= time; i++) idx = i;
    if (idx < 0) continue;
    if (idx > 0) L.polyline(pts.slice(0, idx + 1).map((p) => [p.lat, p.lon]), { color, weight: 5, opacity: 0.9, interactive: false }).addTo(compareLayer);
    const p = pts[idx];
    L.marker([p.lat, p.lon], { icon: pinIcon({ ...(deviceById(id) || {}), color, loc_ts: null }, 32) })
      .bindTooltip(esc(deviceName(deviceById(id) || { name: id })), { permanent: true, direction: "right", offset: [10, 0], className: "marker-label" })
      .bindPopup(`<b>${esc(deviceName(deviceById(id) || { name: id }))}</b><br>${fmtDateTime(p.ts)} · ${fmtAcc(p.accuracy)}`)
      .addTo(compareLayer);
  }
  $("#cmp-label").textContent = fmtDateTime(time);
}

function stopCompare() {
  clearInterval(state.compare.timer);
  state.compare.timer = null;
  setPlayIcon($("#cmp-play"), false);
}
$("#cmp-play").addEventListener("click", () => {
  if (state.compare.timer) return stopCompare();
  let v = parseInt($("#cmp-slider").value, 10);
  if (v >= 1000) v = 0;
  setPlayIcon($("#cmp-play"), true);
  const speed = parseFloat($("#cmp-speed").value);
  state.compare.timer = setInterval(() => {
    v = Math.min(1000, v + 3 * speed);
    setCompareT(v);
    if (v >= 1000) stopCompare();
  }, 100);
});
$("#cmp-slider").addEventListener("input", (e) => { stopCompare(); setCompareT(parseInt(e.target.value, 10)); });

/* ---------- zones ---------- */
function openZones() {
  showPanel("zones");
  renderZoneList();
}
$("#btn-zones").addEventListener("click", openZones);

function renderZoneList() {
  $("#zone-list").innerHTML = state.zones.length ? state.zones.map((z) => {
    const inside = (z.devices || []).map((id) => deviceById(id)).filter(Boolean).map(deviceName);
    return `
    <li data-id="${z.id}">
      <span class="device-color" style="background:${esc(z.color)}"></span>
      <div class="grow">
        <b>${esc(z.name)}</b> <span class="muted small">${Math.round(z.radius)} m</span>
        <div class="muted small">${inside.length ? esc(t("zones.inside", { list: inside.join(", ") })) : esc(t("zones.empty"))}</div>
      </div>
      <button class="btn btn-sm btn-ghost btn-icon" data-zone-act="edit" title="${esc(t("common.edit"))}">${icon("edit", 15)}</button>
      <button class="btn btn-sm btn-ghost btn-icon btn-danger" data-zone-act="delete" title="${esc(t("common.delete"))}">${icon("trash", 15)}</button>
    </li>`;
  }).join("") : `<li class="muted">${esc(t("zones.none"))}</li>`;
}

$("#zone-list").addEventListener("click", async (ev) => {
  const li = ev.target.closest("li[data-id]");
  if (!li) return;
  const zone = state.zones.find((z) => z.id === +li.dataset.id);
  const act = ev.target.closest("[data-zone-act]")?.dataset.zoneAct;
  if (act === "delete") {
    if (!confirm(t("zones.confirmDelete", { name: zone.name }))) return;
    await api(`zones/${zone.id}`, { method: "DELETE" });
    await refreshZones();
    return renderZoneList();
  }
  if (act === "edit") return openZoneForm(zone);
  map.setView([zone.lat, zone.lon], 16);
});

function openZoneForm(zone = null) {
  state.zoneDraft = zone
    ? { id: zone.id, lat: zone.lat, lon: zone.lon, radius: zone.radius, color: zone.color, name: zone.name }
    : { id: null, lat: null, lon: null, radius: 150, color: "#2563eb", name: "" };
  $("#zone-form").hidden = false;
  $("#zone-name").value = state.zoneDraft.name;
  $("#zone-radius").value = state.zoneDraft.radius;
  $("#zone-color").value = state.zoneDraft.color;
  updateRadiusLabel();
  renderZonesLayer();
  renderDraft();
  if (zone) map.setView([zone.lat, zone.lon], 16);
  $("#map").classList.add("placing");
  if (!zone && isPhone()) { setSheet("peek"); toast(t("zones.clickMap")); }
}

function closeZoneForm() {
  state.zoneDraft = null;
  $("#zone-form").hidden = true;
  draftLayer.clearLayers();
  $("#map").classList.remove("placing");
  if (zonesLayer) renderZonesLayer();
}

function renderDraft() {
  draftLayer.clearLayers();
  const z = state.zoneDraft;
  $("#zone-form-hint").textContent = t(z?.lat == null ? "zones.clickMap" : "zones.clickMove");
  if (!z || z.lat == null) return;
  L.circle([z.lat, z.lon], { radius: z.radius, color: z.color, weight: 2, fillOpacity: 0.15 }).addTo(draftLayer);
}

function updateRadiusLabel() {
  $("#zone-radius-label").textContent = `${$("#zone-radius").value} m`;
}

function onMapClick(ev) {
  if (state.panel !== "zones" || !state.zoneDraft) return;
  state.zoneDraft.lat = ev.latlng.lat;
  state.zoneDraft.lon = ev.latlng.lng;
  renderDraft();
  if (isPhone() && state.sheet === "peek") setSheet("half");
}

$("#zone-add").addEventListener("click", () => openZoneForm());
$("#zone-cancel").addEventListener("click", closeZoneForm);
$("#zone-radius").addEventListener("input", () => {
  updateRadiusLabel();
  if (state.zoneDraft) { state.zoneDraft.radius = +$("#zone-radius").value; renderDraft(); }
});
$("#zone-color").addEventListener("input", () => {
  if (state.zoneDraft) { state.zoneDraft.color = $("#zone-color").value; renderDraft(); }
});
$("#zone-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const z = state.zoneDraft;
  if (!z || z.lat == null) return toast(t("zones.clickMap"));
  const body = { name: $("#zone-name").value.trim(), lat: z.lat, lon: z.lon, radius: +$("#zone-radius").value, color: $("#zone-color").value };
  try {
    if (z.id) await api(`zones/${z.id}`, { method: "PATCH", body: JSON.stringify(body) });
    else await api("zones", { method: "POST", body: JSON.stringify(body) });
    closeZoneForm();
    await refreshZones();
    renderZoneList();
    toast(t("zones.saved"));
  } catch (e) { toast(t("error.generic", { msg: e.message })); }
});

async function refreshZones() {
  try {
    state.zones = await api("zones");
    renderZonesLayer();
  } catch { /* transient */ }
}

/* ---------- events ---------- */
const EVENT_ICON = { zone_enter: "enter", zone_exit: "exit", moved: "shieldAlert", lost: "help", found: "check" };
const EVENT_EMOJI = { zone_enter: "→", zone_exit: "←", moved: "⚠", lost: "?", found: "✓" };

function eventText(e) {
  const p = e.params || {};
  if (!p.device) return e.message;
  if (e.kind === "lost" && p.hours == null) return t("event.lost_never", p);
  if (e.kind === "lost") return t("event.lost", { ...p, duration: fmtDuration(p.hours * 3600) });
  return tOr(`event.${e.kind}`, e.message, p);
}

function renderEventBadge() {
  const unread = state.status?.events?.unread || 0;
  const badge = $("#events-badge");
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? "99+" : String(unread);
}

async function checkNewEvents() {
  const ev = state.status?.events;
  if (!ev) return;
  if (state.lastEventId === null) { state.lastEventId = ev.last_id; return; }
  if (ev.last_id <= state.lastEventId) return;
  const fresh = (await api("events?limit=5")).filter((e) => e.id > state.lastEventId);
  state.lastEventId = ev.last_id;
  if (fresh.length) toast(`${EVENT_EMOJI[fresh[0].kind] || "•"} ${eventText(fresh[0])}${fresh.length > 1 ? ` (+${fresh.length - 1})` : ""}`, 7000);
  refreshDevices();
}

async function openEvents() {
  const events = await api("events?limit=200");
  $("#event-list").innerHTML = events.length ? events.map((e) => `
    <li class="${e.read ? "" : "unread"}" data-lat="${e.lat ?? ""}" data-lon="${e.lon ?? ""}" data-text="${esc(eventText(e))}">
      <span class="event-icon k-${esc(e.kind)}">${icon(EVENT_ICON[e.kind] || "bell", 17)}</span>
      <div class="grow">
        <div>${esc(eventText(e))}</div>
        <div class="muted small">${fmtDateTime(e.event_ts || e.ts)} · ${relTime(e.event_ts || e.ts)}</div>
      </div>
    </li>`).join("") : `<li class="muted">${esc(t("events.none"))}</li>`;
  $("#events-dialog").showModal();
  if (events.some((e) => !e.read)) {
    await api("events/read", { method: "POST" });
    refreshStatus();
  }
}
$("#btn-events").addEventListener("click", openEvents);
$("#events-read").addEventListener("click", async () => {
  await api("events/read", { method: "POST" });
  $$("#event-list li.unread").forEach((li) => li.classList.remove("unread"));
  refreshStatus();
});
$("#event-list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-lat]");
  if (!li || !li.dataset.lat) return;
  $("#events-dialog").close();
  if (state.panel !== "devices") showPanel("devices");
  focusLayer.clearLayers();
  const ll = [+li.dataset.lat, +li.dataset.lon];
  L.circleMarker(ll, { radius: 12, color: "#dc2626", weight: 3, fillOpacity: 0.2 }).bindPopup(esc(li.dataset.text)).addTo(focusLayer).openPopup();
  map.setView(ll, 16);
});

/* ---------- status ---------- */
function renderStatus() {
  const s = state.status;
  if (!s) return;
  const g = s.google, p = s.poller;
  const gp = $("#google-pill");
  gp.classList.remove("ok", "warn", "bad");
  let text;
  if (!g.connected) { gp.classList.add("warn"); text = t("status.notConnected"); }
  else if (p.state === "auth_error") { gp.classList.add("bad"); text = t("status.reconnect"); }
  else { gp.classList.add(g.fcm ? "ok" : "warn"); text = g.email || t("status.connected"); }
  $(".pill-text", gp).textContent = text;
  $("#connect-banner").hidden = g.connected;
  renderPollPill();
  renderEventBadge();

  $("#settings-google-status").textContent = g.connected
    ? t("settings.connectedAs", { email: g.email || "?" }) + (g.fcm ? "" : ` · ${t("settings.fcmInactive")}`)
    : t("settings.notConnected");
  $("#settings-connect").textContent = t(g.connected ? "settings.reconnect" : "google.connect");
  $("#google-disconnect").hidden = !g.connected;
  $("#secrets-download").hidden = !g.connected;
}

function renderPollPill() {
  const p = state.status?.poller;
  if (!p) return;
  const el = $("#poll-pill .pill-text");
  if (p.state === "running") el.textContent = p.current_device ? t("poll.running", { device: p.current_device }) : t("poll.runningShort");
  else if (p.state === "not_connected") el.textContent = t("poll.paused");
  else if (p.state === "auth_error" || p.state === "error") el.textContent = `⚠ ${p.last_error || t("poll.error")}`;
  else if (p.next_cycle_at) {
    const left = Math.max(0, Math.round(p.next_cycle_at - Date.now() / 1000));
    el.textContent = t("poll.next", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` });
  }
}

async function refreshStatus() {
  try {
    const prev = state.status?.poller?.last_cycle_finished;
    state.status = await api("status");
    renderStatus();
    await checkNewEvents();
    if (prev && state.status.poller.last_cycle_finished !== prev) {
      await Promise.all([refreshDevices(), refreshZones()]);
      if (state.selectedId && historyRange.live) await loadHistory();
      if (state.panel === "compare" && compareRange.live) await loadCompare(false);
      if (state.panel === "zones") renderZoneList();
    }
  } catch { /* transient network error */ }
}

async function refreshDevices() {
  try {
    state.devices = await api("devices");
    renderDevices();
    renderOverview();
  } catch { /* transient network error */ }
}

$("#btn-poll").addEventListener("click", async () => {
  await api("poll", { method: "POST" });
  toast(t("toast.pollStarted"));
  setTimeout(refreshStatus, 800);
});

/* ---------- device alarms ---------- */
let alarmsDeviceId = null;
function openAlarms(id) {
  const d = deviceById(id);
  if (!d) return;
  alarmsDeviceId = id;
  $("#device-dialog-title").textContent = `${t("devices.alarms")} – ${deviceName(d)}`;
  $("#alarm-lost").value = d.lost_after_hours ? Math.round(d.lost_after_hours) : "";
  $("#alarm-guard").checked = !!d.guard_enabled;
  $("#alarm-radius").value = Math.round(d.guard_radius || 150);
  $("#alarm-from").value = d.guard_from || "";
  $("#alarm-to").value = d.guard_to || "";
  $("#device-dialog").showModal();
}
$("#device-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = {
    lost_after_hours: parseFloat($("#alarm-lost").value) || 0,
    guard_enabled: $("#alarm-guard").checked,
    guard_radius: Math.max(20, parseFloat($("#alarm-radius").value) || 150),
    guard_from: $("#alarm-from").value || null,
    guard_to: $("#alarm-to").value || null,
  };
  try {
    await api(`devices/${enc(alarmsDeviceId)}`, { method: "PATCH", body: JSON.stringify(body) });
    $("#device-dialog").close();
    toast(t("alarms.saved"));
    refreshDevices();
  } catch (e) { toast(t("error.generic", { msg: e.message }), 6000); }
});

/* ---------- settings ---------- */
function openSettings() {
  renderStatus();
  $("#poll-interval").value = Math.round((state.status?.poller.interval || 300) / 60);
  $("#lang-select").innerHTML = Object.entries(LANGS).map(([code, name]) =>
    `<option value="${code}" ${code === currentLang() ? "selected" : ""}>${esc(name)}</option>`).join("");
  $("#settings-devices").innerHTML = state.devices.map((d) => `
    <tr data-id="${esc(d.id)}">
      <td><input type="color" data-f="color" value="${esc(d.color)}"></td>
      <td><input type="text" data-f="custom_name" value="${esc(d.custom_name || "")}" placeholder="${esc(d.name)}"></td>
      <td><input type="checkbox" data-f="tracking" ${d.tracking ? "checked" : ""}></td>
      <td><input type="checkbox" data-f="hidden" ${d.hidden ? "checked" : ""}></td>
      <td><button class="btn btn-sm btn-ghost btn-icon btn-danger" data-f="delete" title="${esc(t("settings.deleteTitle"))}">${icon("trash", 15)}</button></td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">${esc(t("devices.empty"))}</td></tr>`;
  $("#share-devices").innerHTML = state.devices.map((d) => `
    <label class="check"><input type="checkbox" value="${esc(d.id)}"> <span class="device-color" style="background:${esc(d.color)}"></span> ${esc(deviceName(d))}</label>`).join("");
  loadShares();
  $("#settings-dialog").showModal();
}
$("#btn-settings").addEventListener("click", openSettings);
$("#google-pill").addEventListener("click", openSettings);

$("#lang-select").addEventListener("change", (ev) => {
  setLang(ev.target.value);
  rerenderAll();
  openSettings();
});

$("#settings-devices").addEventListener("change", async (ev) => {
  const input = ev.target.closest("[data-f]");
  const tr = ev.target.closest("tr[data-id]");
  if (!input || !tr || input.dataset.f === "delete") return;
  const value = input.type === "checkbox" ? input.checked : input.value;
  try {
    await api(`devices/${enc(tr.dataset.id)}`, { method: "PATCH", body: JSON.stringify({ [input.dataset.f]: value }) });
    await refreshDevices();
  } catch (e) { toast(t("error.generic", { msg: e.message })); }
});
$("#settings-devices").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-f=delete]");
  if (!btn) return;
  const tr = btn.closest("tr[data-id]");
  if (!confirm(t("settings.confirmDelete"))) return;
  await api(`devices/${enc(tr.dataset.id)}`, { method: "DELETE" });
  tr.remove();
  await refreshDevices();
});

$("#poll-interval-save").addEventListener("click", async () => {
  const minutes = Math.max(1, parseInt($("#poll-interval").value, 10) || 5);
  try {
    await api("settings", { method: "PUT", body: JSON.stringify({ poll_interval: minutes * 60 }) });
    toast(t("toast.pollInterval", { minutes }));
    refreshStatus();
  } catch (e) { toast(t("error.generic", { msg: e.message })); }
});

$("#secrets-upload").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await api("google/secrets", { method: "POST", body: fd });
    toast(t("toast.secretsUploaded", { email: res.email || "?" }));
    refreshStatus();
  } catch (e) { toast(t("error.generic", { msg: e.message }), 6000); }
  ev.target.value = "";
});

$("#google-disconnect").addEventListener("click", async () => {
  if (!confirm(t("settings.confirmDisconnect"))) return;
  await api("google", { method: "DELETE" });
  refreshStatus();
});

$("#logout").addEventListener("click", async () => {
  await api("auth/logout", { method: "POST" });
  location.reload();
});

/* ---------- sharing ---------- */
const shareUrl = (token) => `${location.origin}/share.html?t=${enc(token)}`;

async function loadShares() {
  const shares = await api("shares");
  const now = Date.now();
  $("#share-list").innerHTML = shares.length ? shares.map((s) => {
    const expired = s.expires_at && new Date(s.expires_at).getTime() < now;
    const names = s.device_ids.map((id) => deviceById(id)).filter(Boolean).map(deviceName).join(", ");
    const expiry = s.expires_at ? t(expired ? "share.expired" : "share.expiresAt", { date: fmtDateTime(s.expires_at) }) : t("share.never");
    return `
      <li data-token="${esc(s.token)}" class="${expired ? "is-hidden" : ""}">
        <div class="grow">
          <b>${esc(s.label || t("share.untitled"))}</b>
          <div class="muted small">${esc(names)} · ${esc(expiry)}</div>
          <input class="share-link" readonly value="${esc(shareUrl(s.token))}">
        </div>
        <button class="btn btn-sm" data-share-act="copy">${icon("copy", 14)}${esc(t("share.copy"))}</button>
        <button class="btn btn-sm btn-ghost btn-icon btn-danger" data-share-act="delete" title="${esc(t("common.delete"))}">${icon("trash", 15)}</button>
      </li>`;
  }).join("") : `<li class="muted">${esc(t("share.none"))}</li>`;
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs HTTPS; fall back to selecting the field.
    input?.select();
    document.execCommand?.("copy");
  }
  toast(t("share.copied"));
}

$("#share-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const ids = $$("#share-devices input:checked").map((i) => i.value);
  if (!ids.length) return toast(t("share.pickDevice"));
  try {
    const share = await api("shares", {
      method: "POST",
      body: JSON.stringify({ label: $("#share-label").value, device_ids: ids, expires_hours: parseFloat($("#share-expiry").value) }),
    });
    $("#share-label").value = "";
    $$("#share-devices input:checked").forEach((i) => (i.checked = false));
    await loadShares();
    copyText(shareUrl(share.token), $(`#share-list li[data-token="${CSS.escape(share.token)}"] .share-link`));
  } catch (e) { toast(t("error.generic", { msg: e.message })); }
});
$("#share-list").addEventListener("click", async (ev) => {
  const li = ev.target.closest("li[data-token]");
  const act = ev.target.closest("[data-share-act]")?.dataset.shareAct;
  if (!li || !act) return;
  if (act === "copy") return copyText(shareUrl(li.dataset.token), $(".share-link", li));
  if (!confirm(t("share.confirmDelete"))) return;
  await api(`shares/${enc(li.dataset.token)}`, { method: "DELETE" });
  loadShares();
});

/* ---------- connect Google account ---------- */
const STEP_ORDER = ["waiting_login", "waiting_account", "waiting_pin", "finalizing", "done"];
let connectTimer = null;

function vncUrl() {
  const q = new URLSearchParams({ autoconnect: "1", resize: "scale", reconnect: "1", reconnect_delay: "1000", path: "novnc/websockify" });
  return `/novnc/vnc.html?${q}`;
}

// Phones get a narrow (phone-shaped) Chrome window so the sign-in page stays readable.
function loginWindow() {
  return isPhone() ? { width: 500, height: 860 } : { width: 1280, height: 860 };
}

async function startConnect() {
  const win = loginWindow();
  const wrap = $("#vnc-wrap");
  wrap.style.aspectRatio = `${win.width} / ${win.height}`;
  wrap.style.width = isPhone() ? "" : `min(100%, calc((100vh - 400px) * ${win.width} / ${win.height}))`;
  $("#vnc-frame").src = vncUrl();  // fresh noVNC connection on every start
  $("#connect-error").hidden = true;
  $("#connect-message").textContent = t("connect.state.starting");
  try {
    renderConnect(await api("google/login/start", { method: "POST", body: JSON.stringify({ lang: currentLang(), ...win }) }));
  } catch (e) {
    renderConnect({ state: "error", error: e.message });
  }
  clearInterval(connectTimer);
  connectTimer = setInterval(pollConnect, 1500);
}

let vncDownSince = null;
async function pollConnect() {
  try { renderConnect(await api("google/login/status")); } catch { /* ignore */ }
  vncWatchdog();
}

// noVNC sometimes gives up after a dropped connection; reload it if it stays disconnected.
function vncWatchdog() {
  let connected = true;
  try {
    connected = $("#vnc-frame").contentDocument?.documentElement.classList.contains("noVNC_connected") ?? true;
  } catch { /* not loaded yet */ }
  if (connected) { vncDownSince = null; return; }
  vncDownSince ??= Date.now();
  if (Date.now() - vncDownSince > 5000) {
    vncDownSince = null;
    $("#vnc-frame").src = vncUrl();
  }
}

function renderConnect(st) {
  const idx = STEP_ORDER.indexOf(st.state);
  $$("#connect-steps li").forEach((li, i) => {
    li.classList.toggle("active", i === idx);
    li.classList.toggle("done", idx > i || st.state === "done");
  });
  $("#connect-message").textContent = tOr(`connect.state.${st.state}`, st.message || "");
  $("#connect-error").hidden = !st.error;
  $("#connect-error").textContent = st.error ? t("connect.details", { msg: st.error }) : "";
  if (["done", "error", "cancelled"].includes(st.state)) {
    clearInterval(connectTimer);
    connectTimer = null;
  }
  if (st.state === "done") {
    toast(t("connect.state.done"));
    refreshStatus();
    setTimeout(() => { closeConnect(); refreshDevices(); }, 2500);
  }
}

function openConnect() {
  if ($("#settings-dialog").open) $("#settings-dialog").close();
  $("#connect-dialog").showModal();
  startConnect();
}

function closeConnect() {
  clearInterval(connectTimer);
  connectTimer = null;
  $("#vnc-frame").src = "about:blank";
  if ($("#connect-dialog").open) $("#connect-dialog").close();
}

document.addEventListener("click", (ev) => {
  if (ev.target.closest("[data-action=connect]")) openConnect();
});
$("#connect-close").addEventListener("click", closeConnect);

async function sendKeys(text, key) {
  try {
    await api("google/login/type", { method: "POST", body: JSON.stringify({ text, key }) });
    return true;
  } catch (e) {
    toast(t("error.generic", { msg: e.message }));
    return false;
  }
}
$("#type-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = $("#type-input");
  if (await sendKeys(input.value, "enter")) input.value = "";
});
$$("#type-form [data-key]").forEach((b) => b.addEventListener("click", () => sendKeys("", b.dataset.key)));
$("#type-reveal").addEventListener("click", () => {
  const input = $("#type-input");
  input.type = input.type === "password" ? "text" : "password";
  $("#type-reveal").innerHTML = icon(input.type === "password" ? "eye" : "eyeOff");
});
$("#connect-restart").addEventListener("click", startConnect);
$("#connect-cancel").addEventListener("click", async () => {
  await api("google/login/cancel", { method: "POST" }).catch(() => {});
  closeConnect();
});

/* ---------- bottom sheet (phones) ---------- */
const isPhone = () => window.innerWidth <= 800;
const SHEET_STATES = ["peek", "half", "full"];

function setSheet(name) {
  const sidebar = $("#sidebar");
  state.sheet = name;
  sidebar.classList.remove(...SHEET_STATES.map((s) => `sheet-${s}`));
  if (isPhone()) sidebar.classList.add(`sheet-${name}`);
  syncSheetHeight();
}

function syncSheetHeight() {
  const height = isPhone() ? $("#sidebar").getBoundingClientRect().height : 0;
  document.documentElement.style.setProperty("--sheet-h", `${Math.round(height)}px`);
}

(function initSheet() {
  const handle = $("#sheet-handle");
  let startY = null;
  handle.addEventListener("pointerdown", (ev) => { startY = ev.clientY; handle.setPointerCapture(ev.pointerId); });
  handle.addEventListener("pointerup", (ev) => {
    if (startY === null) return;
    const dy = ev.clientY - startY;
    startY = null;
    const i = SHEET_STATES.indexOf(state.sheet || "half");
    if (dy < -30) setSheet(SHEET_STATES[Math.min(2, i + 1)]);
    else if (dy > 30) setSheet(SHEET_STATES[Math.max(0, i - 1)]);
    else setSheet(state.sheet === "peek" ? "half" : state.sheet === "half" ? "full" : "peek");
  });
  $("#sidebar").addEventListener("transitionend", syncSheetHeight);
  window.addEventListener("resize", () => setSheet(state.sheet || "half"));
})();

/* ---------- language ---------- */
function rerenderAll() {
  applyI18n();
  historyRange.render();
  compareRange.render();
  renderStatus();
  renderDevices();
  renderOverview();
  if (state.panel === "history") { renderHistory(false); if (state.tab !== "route") setTab(state.tab); }
  if (state.panel === "compare") { renderCompareList(); setCompareT(+$("#cmp-slider").value); }
  if (state.panel === "zones") { renderZoneList(); if (state.zoneDraft) renderDraft(); }
}

/* ---------- panel login & boot ---------- */
function showLogin() {
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  $("#login-password").focus();
}

$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("#login-error").hidden = true;
  try {
    await api("auth/login", { method: "POST", body: JSON.stringify({ password: $("#login-password").value }) });
    location.reload();
  } catch (e) {
    $("#login-error").textContent = e.message;
    $("#login-error").hidden = false;
  }
});

async function boot() {
  injectIcons();
  setPlayIcon($("#play-btn"), false);
  setPlayIcon($("#cmp-play"), false);
  applyI18n();
  const me = await api("auth/me");
  if (!me.authenticated) return showLogin();
  $("#app-view").hidden = false;
  initMap();
  setSheet("half");
  await Promise.all([refreshStatus(), refreshDevices(), refreshZones()]);
  renderDevices();
  setInterval(refreshStatus, 5000);
  setInterval(() => { refreshDevices(); refreshZones(); }, 30000);
  setInterval(renderPollPill, 1000);
}

boot();
