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
const errorCode = (err) => (err && err.startsWith("code:") ? err.split(":")[1] : null);
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
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  zones: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
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
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
const icon = (name, size = 16) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.tag}</svg>`;
const KIND_ICON = {
  phone: "phone", keys: "key", bike: "bike", car: "car", bag: "bag", wallet: "wallet", headphones: "headphones",
  watch: "watch", laptop: "laptop", dog: "paw", cat: "paw", camera: "camera",
};
const kindIcon = (d) => KIND_ICON[d.kind === "android" ? "phone" : d.device_type] || "tag";
const isFresh = (ts) => ts && Date.now() - new Date(ts).getTime() < 15 * 60e3;
const avatar = (d, cls = "") => `<span class="avatar ${cls}" style="--c:${esc(d.color)}">${icon(kindIcon(d))}</span>`;

function injectIcons(root = document) {
  root.querySelectorAll("[data-icon]:not([data-icon-done])").forEach((el) => {
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon));
    el.dataset.iconDone = "1";
  });
}
const setPlayIcon = (btn, playing) => { btn.innerHTML = icon(playing ? "pause" : "play", 14); };

function pinIcon(d, size = 30, count = 1) {
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size + 3],
    popupAnchor: [0, -size],
    tooltipAnchor: [size / 2 + 2, -size / 2 - 3],
    html: `<div class="pin">${isFresh(d.loc_ts) ? `<span class="pin-pulse" style="background:${esc(d.color)}"></span>` : ""}
      <span class="pin-body" style="background:${esc(d.color)}"></span>
      <span class="pin-icon">${icon(kindIcon(d), 14)}</span>${count > 1 ? `<span class="pin-count">${count}</span>` : ""}</div>`,
  });
}

/** fitBounds that keeps the bottom sheet (phones) from covering the points. */
function fitTo(latlngs, maxZoom = 16) {
  if (!latlngs.length) return;
  if (isPhone()) {
    const sheet = $("#sidebar").getBoundingClientRect().height;
    map.fitBounds(latlngs, { paddingTopLeft: [30, 60], paddingBottomRight: [30, Math.round(sheet) + 20], maxZoom });
  } else {
    map.fitBounds(latlngs, { padding: [60, 60], maxZoom });
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
  sheet: "half",
};

/* ---------- map ---------- */
let map, zonesLayer, overviewLayer, historyLayer, heatLayer, playLayer, staysLayer, compareLayer, draftLayer, focusLayer;

function initMap() {
  map = L.map("map", { zoomControl: false }).setView([52.1, 19.4], 6);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const osmUrl = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
  const attribution = "&copy; OpenStreetMap";
  // Muted / dark variants are the same OSM tiles recoloured with CSS filters (no API key needed).
  const muted = L.tileLayer(osmUrl, { maxZoom: 19, attribution, className: "tiles-muted" });
  const standard = L.tileLayer(osmUrl, { maxZoom: 19, attribution });
  const dark = L.tileLayer(osmUrl, { maxZoom: 19, attribution, className: "tiles-dark" });
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "&copy; Esri",
  });
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  (prefersDark ? dark : muted).addTo(map);
  L.control.layers({ Light: muted, Standard: standard, Dark: dark, Satellite: sat }, null, { position: "topright" }).addTo(map);
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

/* ---------- navigation & panels ---------- */
const PANELS = ["devices", "history", "compare", "zones", "events"];

function showPanel(name) {
  state.panel = name;
  for (const p of PANELS) $(`#${p}-panel`).hidden = p !== name;
  const navName = name === "history" ? "devices" : name;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.nav === navName));
  if (name !== "history") {
    stopPlay();
    state.selectedId = null;
    for (const l of [historyLayer, heatLayer, playLayer, staysLayer]) l.clearLayers();
  }
  if (name !== "compare") { stopCompare(); compareLayer.clearLayers(); }
  if (name !== "zones") closeZoneForm();
  focusLayer.clearLayers();
  $("#sidebar").scrollTop = 0;
  renderOverview();
}

$("#rail").addEventListener("click", (ev) => {
  const item = ev.target.closest("[data-nav]");
  if (!item) return;
  const target = item.dataset.nav;
  if (target === "settings") return openSettings();
  if (target === "devices") showPanel("devices");
  if (target === "compare") openCompare();
  if (target === "zones") openZones();
  if (target === "events") openEvents();
  if (isPhone() && state.sheet === "peek") setSheet("half");
});
$("#account-btn").addEventListener("click", () => openSettings());
$$("[data-back]").forEach((b) => b.addEventListener("click", () => showPanel("devices")));

/* ---------- zones on map ---------- */
function renderZonesLayer() {
  zonesLayer.clearLayers();
  for (const z of state.zones) {
    if (state.zoneDraft?.id === z.id) continue;
    L.circle([z.lat, z.lon], { radius: z.radius, color: z.color, weight: 1.5, dashArray: "5 5", fillOpacity: 0.05, interactive: false })
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
  if (state.panel !== "devices" && state.panel !== "zones" && state.panel !== "events") return;
  const showHidden = $("#show-hidden").checked;
  const visible = state.devices.filter((d) => d.lat != null && (!d.hidden || showHidden));
  const bounds = visible.map((d) => [d.lat, d.lon]);
  for (const d of visible) {
    if (d.accuracy) L.circle([d.lat, d.lon], { radius: d.accuracy, color: d.color, weight: 1, fillOpacity: 0.07, interactive: false }).addTo(overviewLayer);
  }
  // Pins closer than ~40 px on screen are merged into one pin with a counter (they split when zooming in).
  for (const group of clusterOnScreen(visible, 40)) {
    const lead = group.reduce((a, b) => (new Date(b.loc_ts) > new Date(a.loc_ts) ? b : a));
    const names = group.map(deviceName);
    const label = names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
    L.marker([lead.lat, lead.lon], { icon: pinIcon(lead, 30, group.length), riseOnHover: true })
      .bindTooltip(esc(label), { permanent: true, direction: "right", className: "marker-label" })
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
      <div class="popup-title"><span class="swatch" style="background:${esc(d.color)}"></span>${esc(deviceName(d))}</div>
      <div class="muted">${fmtDateTime(d.loc_ts)} · ${relTime(d.loc_ts)}<br>${fmtAcc(d.accuracy)} · ${esc(reportLabel(d))}</div>
      <div class="popup-actions">
        <button class="btn btn-sm" data-popup-act="history" data-id="${esc(d.id)}">${icon("route")}${esc(t("devices.history"))}</button>
        <button class="btn btn-sm" data-popup-act="locate" data-id="${esc(d.id)}">${icon("locate")}<span>${esc(t("devices.locate"))}</span></button>
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
const ringing = new Set();

function zonesOf(deviceId) {
  return state.zones.filter((z) => (z.devices || []).includes(deviceId)).map((z) => z.name);
}

/** Second line of a device row / detail header. */
function deviceSubline(d) {
  const code = errorCode(d.last_error);
  if (d.lat == null) {
    if (d.semantic_name) return `📍 ${esc(d.semantic_name)} · ${relTime(d.sem_ts)}`;
    return esc(code === "no_reports" || code === "timeout" ? t("devices.waitingShort") : t("devices.noLocation"));
  }
  return `${isFresh(d.loc_ts) ? '<span class="live"></span> ' : ""}${relTime(d.loc_ts)} · ${fmtAcc(d.accuracy)} · ${esc(reportLabel(d))}`;
}

// The type chip is noise when the name already says it ("Bike" · bike).
const kindChip = (d) => (kindLabel(d).toLowerCase() === deviceName(d).toLowerCase() ? "" : `<span class="chip">${esc(kindLabel(d))}</span>`);

/** Small status icons on the right of a row. */
function deviceSideIcons(d) {
  const out = [];
  if (zonesOf(d.id).length) out.push(`<span title="${esc(zonesOf(d.id).join(", "))}">${icon("zones")}</span>`);
  if (d.guard_enabled) out.push(`<span class="on" title="${esc(t("devices.guarded"))}">${icon("shield")}</span>`);
  if (d.lost_after_hours) out.push(`<span class="on" title="${esc(t("alarms.lostTitle"))}">${icon("alarm")}</span>`);
  const code = errorCode(d.last_error);
  if (d.last_error && code !== "no_reports" && code !== "timeout") out.push(`<span class="bad" title="${esc(errorText(d.last_error))}">${icon("alert")}</span>`);
  return out.join("");
}

function renderDevices() {
  const query = $("#device-search").value.trim().toLowerCase();
  const showHidden = $("#show-hidden").checked;
  const visible = state.devices.filter((d) => (showHidden || !d.hidden) && (!query || deviceName(d).toLowerCase().includes(query)));
  $("#device-count").textContent = String(state.devices.length);
  $("#devices-empty").hidden = visible.length > 0 || !!query;
  $("#device-list").innerHTML = visible.map((d) => `
    <li class="row ${d.hidden ? "is-hidden" : ""}" data-id="${esc(d.id)}">
      ${avatar(d)}
      <div class="row-main">
        <div class="row-title"><span class="name">${esc(deviceName(d))}</span>${kindChip(d)}</div>
        <div class="row-sub">${deviceSubline(d)}</div>
      </div>
      <div class="row-side">${deviceSideIcons(d)}
        <button class="btn btn-ghost btn-icon btn-sm quick" data-act="locate" title="${esc(t("devices.locate"))}">${icon("locate")}</button>
      </div>
    </li>`).join("");
}

$("#device-list").addEventListener("click", (ev) => {
  const li = ev.target.closest(".row");
  if (!li) return;
  if (ev.target.closest("[data-act=locate]")) return locateDevice(li.dataset.id, ev.target);
  selectDevice(li.dataset.id);
});
$("#device-search").addEventListener("input", renderDevices);
$("#show-hidden").addEventListener("change", () => { renderDevices(); renderOverview(); });

async function locateDevice(id, el) {
  const btn = el.closest("button");
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

async function toggleSound(id) {
  const start = !ringing.has(id);
  try {
    await api(`devices/${enc(id)}/sound`, { method: "POST", body: JSON.stringify({ start }) });
    if (start) {
      ringing.add(id);
      toast(t("toast.soundSent"));
      setTimeout(() => { ringing.delete(id); renderDetailHeader(); }, 30000);
    } else {
      ringing.delete(id);
    }
    renderDetailHeader();
  } catch (e) {
    toast(t("error.generic", { msg: e.message }));
  }
}

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

/* ---------- device detail / history ---------- */
function selectDevice(id) {
  showPanel("history");
  setSheet("half");
  state.selectedId = id;
  renderDetailHeader();
  overviewLayer.clearLayers();
  loadHistory(true);
}

function renderDetailHeader() {
  const d = deviceById(state.selectedId);
  if (!d) return;
  const zones = zonesOf(d.id);
  $("#detail-device").innerHTML = `
    ${avatar(d, "avatar-lg")}
    <div class="row-main">
      <div class="row-title"><span class="name">${esc(deviceName(d))}</span>${kindChip(d)}</div>
      <div class="row-sub">${deviceSubline(d)}</div>
    </div>`;
  const badges = [
    ...zones.map((z) => `<span class="chip accent">${icon("zones")}${esc(z)}</span>`),
    d.guard_enabled ? `<span class="chip warn">${icon("shield")}${esc(t("devices.guarded"))}${d.guard_from ? ` ${esc(d.guard_from)}–${esc(d.guard_to || "")}` : ""}</span>` : "",
    d.lost_after_hours ? `<span class="chip accent">${icon("alarm")}${Math.round(d.lost_after_hours)} h</span>` : "",
  ].join("");
  const code = errorCode(d.last_error);
  let note = "";
  if (d.last_error) {
    const calm = code === "no_reports" || code === "timeout";
    const text = calm && !d.points ? t("devices.waitingFirst") : errorText(d.last_error);
    note = `<div class="detail-note ${calm ? "" : "bad"}">${icon(calm ? "info" : "alert")}<span>${esc(text)}</span></div>`;
  }
  const ring = ringing.has(d.id);
  const alarmsOn = !!(d.guard_enabled || d.lost_after_hours);
  $("#detail-actions").innerHTML = `
    <button class="btn btn-sm" data-detail="locate">${icon("locate")}<span>${esc(t("devices.locate"))}</span></button>
    <button class="btn btn-sm ${ring ? "on" : ""}" data-detail="sound">${icon(ring ? "mute" : "sound")}<span>${esc(t(ring ? "devices.stopSound" : "devices.sound"))}</span></button>
    <button class="btn btn-sm ${alarmsOn ? "on" : ""}" data-detail="alarms">${icon("alarm")}<span>${esc(t("devices.alarms"))}</span></button>`;
  $("#detail-extra").innerHTML = (badges ? `<div class="detail-badges">${badges}</div>` : "") + note;
}

$("#detail-actions").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-detail]");
  if (!btn || !state.selectedId) return;
  const act = btn.dataset.detail;
  if (act === "locate") locateDevice(state.selectedId, btn);
  if (act === "sound") toggleSound(state.selectedId);
  if (act === "alarms") openAlarms(state.selectedId);
});

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
const selectedColor = () => deviceById(state.selectedId)?.color || "#3b6cf6";

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
    L.polyline(latlngs, { color, weight: 3, opacity: 0.7 }).addTo(historyLayer);
  }
  if ($("#show-points").checked) {
    pts.forEach((p, i) => {
      const last = i === pts.length - 1;
      L.circleMarker([p.lat, p.lon], {
        radius: last ? 7 : 3.5, color: last ? "#fff" : color, weight: last ? 2 : 1, fillColor: color, fillOpacity: last ? 1 : 0.55,
      })
        .bindPopup(`<b>${fmtDateTime(p.ts)}</b><br>${fmtAcc(p.accuracy)} · ${esc(reportLabel(p))}`)
        .on("click", () => setPlayIndex(i))
        .addTo(historyLayer);
    });
  }
  if (pts.length) {
    const lastP = pts[pts.length - 1];
    if (lastP.accuracy) L.circle([lastP.lat, lastP.lon], { radius: lastP.accuracy, color, weight: 1, fillOpacity: 0.07, interactive: false }).addTo(historyLayer);
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
    ? rows.map((p) => `<li data-ts="${esc(p.ts)}"><span>${fmtDateTime(p.ts)}</span><span class="tag">${fmtAcc(p.accuracy)} · ${esc(reportLabel(p))}</span></li>`).join("")
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
  list.innerHTML = `<li class="empty">${esc(t("common.loading"))}</li>`;
  const stays = await api(`devices/${enc(id)}/stays?${historyRange.query()}`);
  if (state.selectedId !== id || state.tab !== "stays") return;
  staysLayer.clearLayers();
  const color = selectedColor();
  stays.forEach((s, i) => {
    L.circleMarker([s.lat, s.lon], { radius: 12, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.9 })
      .bindTooltip(String(i + 1), { permanent: true, direction: "center", className: "stay-number" })
      .bindPopup(`<b>${esc(s.zone || t("stays.place"))}</b><br>${fmtDateTime(s.start)} – ${fmtDateTime(s.end)}<br>${esc(fmtDuration(s.duration_s))}`)
      .addTo(staysLayer);
  });
  list.innerHTML = stays.length ? stays.map((s, i) => `
    <li class="row" data-lat="${s.lat}" data-lon="${s.lon}">
      <span class="stay-num" style="background:${esc(color)}">${i + 1}</span>
      <div class="row-main">
        <div class="row-title"><span class="name">${esc(s.zone || `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`)}</span></div>
        <div class="row-sub">${fmtDateTime(s.start)} – ${fmtTime(s.end)}</div>
      </div>
      <span class="chip">${esc(fmtDuration(s.duration_s))}</span>
    </li>`).join("") : `<li class="empty">${esc(t("stays.empty"))}</li>`;
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
  if (i > 0) L.polyline(pts.slice(0, i + 1).map((q) => [q.lat, q.lon]), { color, weight: 5, opacity: 0.9 }).addTo(playLayer);
  L.circleMarker([p.lat, p.lon], { radius: 8, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 }).addTo(playLayer);
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

function renderCompareList() {
  $("#compare-devices").innerHTML = state.devices.map((d) => `
    <li class="row">
      <label class="check grow">
        <input type="checkbox" value="${esc(d.id)}" ${state.compare.ids.has(d.id) ? "checked" : ""}>
        ${avatar(d)}
        <span class="grow">${esc(deviceName(d))}</span>
      </label>
      <span class="chip" data-cmp-count="${esc(d.id)}">–</span>
    </li>`).join("");
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
    const dev = deviceById(id) || { name: id };
    const color = dev.color || "#3b6cf6";
    L.polyline(pts.map((p) => [p.lat, p.lon]), { color, weight: 2, opacity: 0.3, interactive: false }).addTo(compareLayer);
    let idx = -1;
    for (let i = 0; i < pts.length && pts[i].t <= time; i++) idx = i;
    if (idx < 0) continue;
    if (idx > 0) L.polyline(pts.slice(0, idx + 1).map((p) => [p.lat, p.lon]), { color, weight: 4, opacity: 0.9, interactive: false }).addTo(compareLayer);
    const p = pts[idx];
    L.marker([p.lat, p.lon], { icon: pinIcon({ ...dev, color, loc_ts: null }, 28) })
      .bindTooltip(esc(deviceName(dev)), { permanent: true, direction: "right", className: "marker-label" })
      .bindPopup(`<b>${esc(deviceName(dev))}</b><br>${fmtDateTime(p.ts)} · ${fmtAcc(p.accuracy)}`)
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

function renderZoneList() {
  $("#zone-list").innerHTML = state.zones.length ? state.zones.map((z) => {
    const inside = (z.devices || []).map((id) => deviceById(id)).filter(Boolean).map(deviceName);
    return `
    <li class="row" data-id="${z.id}">
      <span class="avatar" style="--c:${esc(z.color)}">${icon("zones")}</span>
      <div class="row-main">
        <div class="row-title"><span class="name">${esc(z.name)}</span><span class="chip">${Math.round(z.radius)} m</span></div>
        <div class="row-sub">${inside.length ? esc(t("zones.inside", { list: inside.join(", ") })) : esc(t("zones.empty"))}</div>
      </div>
      <div class="row-side">
        <button class="btn btn-ghost btn-icon btn-sm quick" data-zone-act="edit" title="${esc(t("common.edit"))}">${icon("edit")}</button>
        <button class="btn btn-ghost btn-icon btn-sm quick btn-danger" data-zone-act="delete" title="${esc(t("common.delete"))}">${icon("trash")}</button>
      </div>
    </li>`;
  }).join("") : `<li class="empty">${esc(t("zones.none"))}</li>`;
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
    : { id: null, lat: null, lon: null, radius: 150, color: "#3b6cf6", name: "" };
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
  if (draftLayer) draftLayer.clearLayers();
  $("#map").classList.remove("placing");
  if (zonesLayer) renderZonesLayer();
}

function renderDraft() {
  draftLayer.clearLayers();
  const z = state.zoneDraft;
  $("#zone-form-hint").textContent = t(z?.lat == null ? "zones.clickMap" : "zones.clickMove");
  if (!z || z.lat == null) return;
  L.circle([z.lat, z.lon], { radius: z.radius, color: z.color, weight: 2, fillOpacity: 0.12 }).addTo(draftLayer);
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
  if (state.panel === "events") loadEvents(false);
}

async function openEvents() {
  showPanel("events");
  await loadEvents(true);
}

async function loadEvents(markRead) {
  const events = await api("events?limit=200");
  $("#event-list").innerHTML = events.length ? events.map((e) => `
    <li class="row ${e.read ? "" : "unread"}" data-lat="${e.lat ?? ""}" data-lon="${e.lon ?? ""}" data-text="${esc(eventText(e))}">
      <span class="event-icon k-${esc(e.kind)}">${icon(EVENT_ICON[e.kind] || "bell")}</span>
      <div class="row-main">
        <div class="row-title"><span>${esc(eventText(e))}</span></div>
        <div class="row-sub">${fmtDateTime(e.event_ts || e.ts)} · ${relTime(e.event_ts || e.ts)}</div>
      </div>
    </li>`).join("") : `<li class="empty">${esc(t("events.none"))}</li>`;
  if (markRead && events.some((e) => !e.read)) {
    await api("events/read", { method: "POST" });
    refreshStatus();
  }
}
$("#events-read").addEventListener("click", async () => {
  await api("events/read", { method: "POST" });
  $$("#event-list .unread").forEach((li) => li.classList.remove("unread"));
  refreshStatus();
});
$("#event-list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-lat]");
  if (!li || !li.dataset.lat) return;
  focusLayer.clearLayers();
  const ll = [+li.dataset.lat, +li.dataset.lon];
  L.circleMarker(ll, { radius: 11, color: "#dc2626", weight: 2.5, fillOpacity: 0.15 }).bindPopup(esc(li.dataset.text)).addTo(focusLayer).openPopup();
  map.setView(ll, 16);
  if (isPhone()) setSheet("peek");
});

/* ---------- status ---------- */
function renderStatus() {
  const s = state.status;
  if (!s) return;
  const g = s.google, p = s.poller;
  const dot = $("#account-dot");
  dot.className = "status-dot";
  let text;
  if (!g.connected) { dot.classList.add("warn"); text = t("status.notConnected"); }
  else if (p.state === "auth_error") { dot.classList.add("bad"); text = t("status.reconnect"); }
  else { dot.classList.add(g.fcm ? "ok" : "warn"); text = g.email || t("status.connected"); }
  $("#account-email").textContent = text;
  $("#connect-banner").hidden = g.connected;
  renderPollStatus();
  renderEventBadge();

  $("#settings-google-status").textContent = g.connected
    ? t("settings.connectedAs", { email: g.email || "?" }) + (g.fcm ? "" : ` · ${t("settings.fcmInactive")}`)
    : t("settings.notConnected");
  $("#settings-connect").textContent = t(g.connected ? "settings.reconnect" : "google.connect");
  $("#google-disconnect").hidden = !g.connected;
  $("#secrets-download").hidden = !g.connected;
}

function renderPollStatus() {
  const p = state.status?.poller;
  if (!p) return;
  let text = "", cls = "ok";
  if (p.state === "running") { text = p.current_device ? t("poll.running", { device: p.current_device }) : t("poll.runningShort"); cls = "busy"; }
  else if (p.state === "not_connected") { text = t("poll.paused"); cls = "warn"; }
  else if (p.state === "auth_error" || p.state === "error") { text = p.last_error || t("poll.error"); cls = "bad"; }
  else if (p.next_cycle_at) {
    const left = Math.max(0, Math.round(p.next_cycle_at - Date.now() / 1000));
    text = t("poll.next", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` });
  }
  $$("[data-poll-text]").forEach((el) => (el.textContent = text));
  $$("[data-poll-dot]").forEach((el) => (el.className = `status-dot ${cls}`));
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
    if (state.panel === "history") renderDetailHeader();
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
  $("#device-dialog-title").textContent = `${t("devices.alarms")} · ${deviceName(d)}`;
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
      <td><button class="btn btn-sm btn-ghost btn-icon btn-danger" data-f="delete" title="${esc(t("settings.deleteTitle"))}">${icon("trash")}</button></td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">${esc(t("devices.empty"))}</td></tr>`;
  $("#share-devices").innerHTML = state.devices.map((d) => `
    <label class="check"><input type="checkbox" value="${esc(d.id)}"><span class="swatch" style="background:${esc(d.color)}"></span>${esc(deviceName(d))}</label>`).join("");
  loadShares();
  if (!$("#settings-dialog").open) $("#settings-dialog").showModal();
}

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
      <li class="row ${expired ? "is-hidden" : ""}" data-token="${esc(s.token)}">
        <div class="row-main">
          <div class="row-title"><span class="name">${esc(s.label || t("share.untitled"))}</span><span class="chip">${esc(expiry)}</span></div>
          <div class="row-sub">${esc(names)}</div>
          <input class="share-link" readonly value="${esc(shareUrl(s.token))}">
        </div>
        <div class="row-side">
          <button class="btn btn-sm" data-share-act="copy">${icon("copy")}${esc(t("share.copy"))}</button>
          <button class="btn btn-sm btn-ghost btn-icon btn-danger" data-share-act="delete" title="${esc(t("common.delete"))}">${icon("trash")}</button>
        </div>
      </li>`;
  }).join("") : `<li class="empty">${esc(t("share.none"))}</li>`;
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The Clipboard API needs HTTPS; fall back to selecting the field.
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
  wrap.style.width = isPhone() ? "" : `min(100%, calc((100vh - 420px) * ${win.width} / ${win.height}))`;
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
$("#connect-restart").addEventListener("click", startConnect);
$("#connect-cancel").addEventListener("click", async () => {
  await api("google/login/cancel", { method: "POST" }).catch(() => {});
  closeConnect();
});

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
  window.addEventListener("resize", () => { setSheet(state.sheet || "half"); map?.invalidateSize(); });
})();

/* ---------- language ---------- */
function rerenderAll() {
  applyI18n();
  historyRange.render();
  compareRange.render();
  renderStatus();
  renderDevices();
  renderOverview();
  if (state.panel === "history") { renderDetailHeader(); renderHistory(false); if (state.tab !== "route") setTab(state.tab); }
  if (state.panel === "compare") { renderCompareList(); setCompareT(+$("#cmp-slider").value); }
  if (state.panel === "zones") { renderZoneList(); if (state.zoneDraft) renderDraft(); }
  if (state.panel === "events") loadEvents(false);
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
  showPanel("devices");
  setSheet("half");
  await Promise.all([refreshStatus(), refreshDevices(), refreshZones()]);
  renderDevices();
  setInterval(refreshStatus, 5000);
  setInterval(() => { refreshDevices(); refreshZones(); }, 30000);
  setInterval(renderPollStatus, 1000);
}

boot();
