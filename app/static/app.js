"use strict";

/* ---------- narzędzia ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch("/api/" + path, { credentials: "same-origin", headers, ...opts });
  if (res.status === 401 && !path.startsWith("auth/")) {
    showLogin();
    throw new Error("Sesja wygasła");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* brak JSON */ }
    throw new Error(detail);
  }
  return (res.headers.get("content-type") || "").includes("json") ? res.json() : res.text();
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function ago(ts) {
  if (!ts) return "nigdy";
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return "przed chwilą";
  if (s < 3600) return `${Math.round(s / 60)} min temu`;
  if (s < 86400) return `${Math.round(s / 3600)} godz. temu`;
  return `${Math.round(s / 86400)} dni temu`;
}
const fmtTime = (ts) => new Date(ts).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "medium" });
const fmtAcc = (a) => (a ? `±${a >= 1000 ? (a / 1000).toFixed(1) + " km" : Math.round(a) + " m"}` : "");

const STATUS_LABEL = { 0: "semantyczna", 1: "ostatnia znana", 2: "sieć Find Hub", 3: "zagregowana" };
function reportLabel(p) {
  if (p.lat == null) return `📍 ${p.semantic_name || "miejsce"}`;
  return p.is_own_report ? "Twój telefon" : STATUS_LABEL[p.status] || "raport";
}

const TYPE_LABEL = {
  beacon: "tag", keys: "klucze", wallet: "portfel", bag: "torba", headphones: "słuchawki", watch: "zegarek",
  laptop: "laptop", car: "auto", bike: "rower", camera: "aparat", cat: "kot", dog: "pies", remote_control: "pilot",
  badge: "identyfikator", charger: "ładowarka", clothing: "ubranie",
};
const kindLabel = (d) => (d.kind === "android" ? "telefon" : TYPE_LABEL[d.device_type] || d.device_type || "tag");
const deviceName = (d) => d.custom_name || d.name;
function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  const word = n === 1 ? one : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${word}`;
}

function haversine(a, b) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- stan ---------- */
const state = {
  devices: [],
  status: null,
  selectedId: null,
  range: "24h",
  history: [],
  fitted: false,
  playIndex: 0,
  playTimer: null,
};

/* ---------- mapa ---------- */
let map, overviewLayer, historyLayer, playLayer;

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([52.1, 19.4], 6);
  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap",
  }).addTo(map);
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "&copy; Esri",
  });
  L.control.layers({ Mapa: osm, Satelita: sat }, null, { position: "topright" }).addTo(map);
  overviewLayer = L.layerGroup().addTo(map);
  historyLayer = L.layerGroup().addTo(map);
  playLayer = L.layerGroup().addTo(map);
}

function renderOverview() {
  overviewLayer.clearLayers();
  if (state.selectedId) return;
  const showHidden = $("#show-hidden").checked;
  const bounds = [];
  for (const d of state.devices) {
    if (d.lat == null || (d.hidden && !showHidden)) continue;
    const ll = [d.lat, d.lon];
    bounds.push(ll);
    if (d.accuracy) {
      L.circle(ll, { radius: d.accuracy, color: d.color, weight: 1, fillOpacity: 0.08 }).addTo(overviewLayer);
    }
    L.circleMarker(ll, { radius: 8, color: "#fff", weight: 2, fillColor: d.color, fillOpacity: 1 })
      .bindTooltip(esc(deviceName(d)), { permanent: true, direction: "right", offset: [10, 0], className: "marker-label" })
      .bindPopup(`<b>${esc(deviceName(d))}</b><br>${fmtTime(d.loc_ts)} (${ago(d.loc_ts)})<br>${fmtAcc(d.accuracy)} · ${esc(reportLabel(d))}`)
      .on("dblclick", () => selectDevice(d.id))
      .addTo(overviewLayer);
  }
  if (!state.fitted && bounds.length) {
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
    state.fitted = true;
  }
}

/* ---------- lista urządzeń ---------- */
function renderDevices() {
  const list = $("#device-list");
  const showHidden = $("#show-hidden").checked;
  const visible = state.devices.filter((d) => showHidden || !d.hidden);
  $("#devices-empty").hidden = visible.length > 0;
  list.innerHTML = visible.map((d) => {
    const where = d.lat != null
      ? `${ago(d.loc_ts)} · ${fmtAcc(d.accuracy)} · ${esc(reportLabel(d))}`
      : "brak lokalizacji";
    const sem = d.semantic_name && (!d.loc_ts || new Date(d.sem_ts) > new Date(d.loc_ts))
      ? `<div class="device-meta">📍 ${esc(d.semantic_name)} · ${ago(d.sem_ts)}</div>` : "";
    return `
      <li class="device ${d.hidden ? "is-hidden" : ""}" data-id="${esc(d.id)}">
        <div class="device-top">
          <span class="device-color" style="background:${esc(d.color)}"></span>
          <span class="device-name">${esc(deviceName(d))}</span>
          <span class="device-kind">${esc(kindLabel(d))}</span>
        </div>
        <div class="device-meta">${where}</div>
        ${sem}
        <div class="device-meta">${plural(d.points, "punkt", "punkty", "punktów")} w historii${d.tracking ? "" : " · nie śledzony"}</div>
        ${d.last_error ? `<div class="device-error">⚠ ${esc(d.last_error)}</div>` : ""}
        <div class="device-actions">
          <button class="btn btn-sm" data-act="history">Historia</button>
          <button class="btn btn-sm" data-act="locate">Zlokalizuj</button>
          <button class="btn btn-sm" data-act="sound">Dźwięk</button>
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
  const d = state.devices.find((x) => x.id === id);
  if (d?.lat != null) map.setView([d.lat, d.lon], Math.max(map.getZoom(), 15));
});

async function locateDevice(id, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Lokalizuję…";
  try {
    const res = await api(`devices/${encodeURIComponent(id)}/locate`, { method: "POST" });
    toast(res.error ? `⚠ ${res.error}`
      : res.new_points ? `Nowe: ${plural(res.new_points, "punkt", "punkty", "punktów")}`
      : "Odpowiedź otrzymana - brak nowej pozycji od ostatniego odczytu.");
    await refreshDevices();
    if (state.selectedId === id) await loadHistory();
  } catch (e) {
    toast(`Błąd: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

const ringing = new Set();
async function toggleSound(id, btn) {
  const start = !ringing.has(id);
  try {
    await api(`devices/${encodeURIComponent(id)}/sound`, { method: "POST", body: JSON.stringify({ start }) });
    if (start) {
      ringing.add(id);
      btn.textContent = "Zatrzymaj";
      toast("Wysłano polecenie odtworzenia dźwięku (tag musi być w zasięgu Bluetooth telefonu).");
      setTimeout(() => { ringing.delete(id); btn.textContent = "Dźwięk"; }, 30000);
    } else {
      ringing.delete(id);
      btn.textContent = "Dźwięk";
    }
  } catch (e) {
    toast(`Błąd: ${e.message}`);
  }
}

$("#show-hidden").addEventListener("change", () => { renderDevices(); renderOverview(); });

/* ---------- historia ---------- */
function rangeBounds() {
  const now = new Date();
  const hours = { "6h": 6, "24h": 24, "7d": 168, "30d": 720 }[state.range];
  if (hours) return [new Date(now - hours * 3600e3), now];
  const from = $("#range-from").value ? new Date($("#range-from").value) : new Date(now - 24 * 3600e3);
  const to = $("#range-to").value ? new Date($("#range-to").value) : now;
  return [from, to];
}

function historyQuery() {
  const [from, to] = rangeBounds();
  const q = new URLSearchParams({ start: from.toISOString(), end: to.toISOString() });
  const acc = $("#accuracy-filter").value;
  if (acc) q.set("max_accuracy", acc);
  return q.toString();
}

function selectDevice(id) {
  state.selectedId = id;
  const d = state.devices.find((x) => x.id === id);
  $("#devices-panel").hidden = true;
  $("#history-panel").hidden = false;
  $("#history-title").textContent = d ? deviceName(d) : id;
  overviewLayer.clearLayers();
  loadHistory(true);
}

function closeHistory() {
  stopPlay();
  state.selectedId = null;
  state.history = [];
  historyLayer.clearLayers();
  playLayer.clearLayers();
  $("#history-panel").hidden = true;
  $("#devices-panel").hidden = false;
  renderOverview();
}
$("#history-back").addEventListener("click", closeHistory);

async function loadHistory(fit = false) {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const q = historyQuery();
  const rows = await api(`devices/${encodeURIComponent(id)}/history?${q}`);
  if (state.selectedId !== id) return;
  state.history = rows;
  for (const fmt of ["gpx", "csv", "geojson"]) {
    $(`#export-${fmt}`).href = `/api/devices/${encodeURIComponent(id)}/export.${fmt}?${q}`;
  }
  renderHistory(fit);
}

function geoPoints() {
  return state.history.filter((p) => p.lat != null);
}

function renderHistory(fit) {
  stopPlay();
  historyLayer.clearLayers();
  playLayer.clearLayers();
  const d = state.devices.find((x) => x.id === state.selectedId);
  const color = d?.color || "#2563eb";
  const pts = geoPoints();
  const latlngs = pts.map((p) => [p.lat, p.lon]);

  if ($("#show-line").checked && latlngs.length > 1) {
    L.polyline(latlngs, { color, weight: 3, opacity: 0.75 }).addTo(historyLayer);
  }
  if ($("#show-points").checked) {
    pts.forEach((p, i) => {
      const last = i === pts.length - 1;
      L.circleMarker([p.lat, p.lon], {
        radius: last ? 8 : 4, color: last ? "#fff" : color, weight: last ? 2 : 1,
        fillColor: color, fillOpacity: last ? 1 : 0.6,
      })
        .bindPopup(`<b>${fmtTime(p.ts)}</b><br>${fmtAcc(p.accuracy)} · ${esc(reportLabel(p))}`)
        .on("click", () => setPlayIndex(i))
        .addTo(historyLayer);
    });
  }
  if (pts.length) {
    const lastP = pts[pts.length - 1];
    if (lastP.accuracy) L.circle([lastP.lat, lastP.lon], { radius: lastP.accuracy, color, weight: 1, fillOpacity: 0.08 }).addTo(historyLayer);
  }
  if (fit && latlngs.length) map.fitBounds(latlngs, { padding: [50, 50], maxZoom: 17 });

  // statystyki
  let dist = 0;
  for (let i = 1; i < pts.length; i++) dist += haversine(pts[i - 1], pts[i]);
  const span = pts.length > 1 ? (new Date(pts[pts.length - 1].ts) - new Date(pts[0].ts)) / 3600e3 : 0;
  $("#history-stats").innerHTML = `
    <div class="stat"><b>${pts.length}</b><span>${plural(pts.length, "punkt", "punkty", "punktów").split(" ")[1]}</span></div>
    <div class="stat"><b>${(dist / 1000).toFixed(dist < 10000 ? 2 : 1)} km</b><span>dystans (szac.)</span></div>
    <div class="stat"><b>${span < 48 ? span.toFixed(1) + " h" : (span / 24).toFixed(1) + " d"}</b><span>zakres</span></div>`;

  // odtwarzacz
  const slider = $("#play-slider");
  slider.max = Math.max(0, pts.length - 1);
  slider.disabled = pts.length < 2;
  $("#play-btn").disabled = pts.length < 2;
  setPlayIndex(Math.max(0, pts.length - 1), false);

  // lista punktów (najnowsze na górze)
  const rows = state.history.slice(-300).reverse();
  $("#point-list").innerHTML = rows.length
    ? rows.map((p) => `<li data-ts="${esc(p.ts)}"><span>${fmtTime(p.ts)}</span><span class="tag">${fmtAcc(p.accuracy)} ${esc(reportLabel(p))}</span></li>`).join("")
    : `<li class="muted">Brak punktów w tym zakresie.</li>`;
}

$("#point-list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-ts]");
  if (!li) return;
  const i = geoPoints().findIndex((p) => p.ts === li.dataset.ts);
  if (i >= 0) setPlayIndex(i);
});

/* ---------- odtwarzanie trasy ---------- */
let playMarker, playTrail;

function setPlayIndex(i, pan = true) {
  const pts = geoPoints();
  playLayer.clearLayers();
  playMarker = playTrail = null;
  if (!pts.length) { $("#play-label").textContent = ""; return; }
  i = Math.min(Math.max(0, i), pts.length - 1);
  state.playIndex = i;
  $("#play-slider").value = i;
  const d = state.devices.find((x) => x.id === state.selectedId);
  const color = d?.color || "#2563eb";
  const p = pts[i];
  if (i > 0) {
    playTrail = L.polyline(pts.slice(0, i + 1).map((q) => [q.lat, q.lon]), { color, weight: 6, opacity: 0.9 }).addTo(playLayer);
  }
  playMarker = L.circleMarker([p.lat, p.lon], { radius: 10, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 }).addTo(playLayer);
  $("#play-label").textContent = `${i + 1}/${pts.length} · ${fmtTime(p.ts)} · ${fmtAcc(p.accuracy)} · ${reportLabel(p)}`;
  if (pan && !map.getBounds().pad(-0.15).contains([p.lat, p.lon])) map.panTo([p.lat, p.lon]);
}

function stopPlay() {
  clearInterval(state.playTimer);
  state.playTimer = null;
  $("#play-btn").textContent = "▶";
}

function togglePlay() {
  if (state.playTimer) return stopPlay();
  const pts = geoPoints();
  if (pts.length < 2) return;
  if (state.playIndex >= pts.length - 1) setPlayIndex(0);
  $("#play-btn").textContent = "❚❚";
  const speed = parseFloat($("#play-speed").value);
  state.playTimer = setInterval(() => {
    if (state.playIndex >= geoPoints().length - 1) return stopPlay();
    setPlayIndex(state.playIndex + 1);
  }, 700 / speed);
}

$("#play-btn").addEventListener("click", togglePlay);
$("#play-slider").addEventListener("input", (e) => { stopPlay(); setPlayIndex(parseInt(e.target.value, 10)); });
$("#play-speed").addEventListener("change", () => { if (state.playTimer) { stopPlay(); togglePlay(); } });

$("#range-chips").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-range]");
  if (!btn) return;
  $$("#range-chips button").forEach((b) => b.classList.toggle("active", b === btn));
  state.range = btn.dataset.range;
  $("#custom-range").hidden = state.range !== "custom";
  if (state.range === "custom") {
    const toLocal = (d) => new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
    if (!$("#range-from").value) $("#range-from").value = toLocal(new Date(Date.now() - 24 * 3600e3));
    if (!$("#range-to").value) $("#range-to").value = toLocal(new Date());
    return;
  }
  loadHistory(true);
});
$("#range-apply").addEventListener("click", () => loadHistory(true));
$("#accuracy-filter").addEventListener("change", () => loadHistory(false));
$("#show-points").addEventListener("change", () => renderHistory(false));
$("#show-line").addEventListener("change", () => renderHistory(false));

/* ---------- status ---------- */
function renderStatus() {
  const s = state.status;
  if (!s) return;
  const g = s.google, p = s.poller;
  const gp = $("#google-pill");
  gp.classList.remove("ok", "warn", "bad");
  if (!g.connected) {
    gp.classList.add("warn");
    gp.querySelector(".pill-text").textContent = "Google: niepołączone";
  } else if (p.state === "auth_error") {
    gp.classList.add("bad");
    gp.querySelector(".pill-text").textContent = "Google: połącz ponownie";
  } else {
    gp.classList.add(g.fcm ? "ok" : "warn");
    gp.querySelector(".pill-text").textContent = g.email || "Google: połączone";
  }
  $("#connect-banner").hidden = g.connected;
  renderPollPill();

  $("#settings-google-status").textContent = g.connected
    ? `Połączone: ${g.email || "(nieznany e-mail)"}${g.fcm ? "" : " · kanał push (FCM) nieaktywny"}`
    : "Konto Google nie jest połączone.";
  $("#settings-connect").textContent = g.connected ? "Połącz ponownie" : "Połącz konto Google";
  $("#google-disconnect").hidden = !g.connected;
  $("#secrets-download").hidden = !g.connected;
}

function renderPollPill() {
  const s = state.status;
  if (!s) return;
  const p = s.poller;
  const el = $("#poll-pill .pill-text");
  if (p.state === "running") {
    el.textContent = `Odpytuję${p.current_device ? ": " + p.current_device : "…"}`;
  } else if (p.state === "not_connected") {
    el.textContent = "Odpytywanie wstrzymane";
  } else if (p.state === "auth_error" || p.state === "error") {
    el.textContent = `⚠ ${p.last_error || "błąd"}`;
  } else if (p.next_cycle_at) {
    const left = Math.max(0, Math.round(p.next_cycle_at - Date.now() / 1000));
    el.textContent = `Następny odczyt za ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  }
}

async function refreshStatus() {
  try {
    const prev = state.status?.poller?.last_cycle_finished;
    state.status = await api("status");
    renderStatus();
    if (prev && state.status.poller.last_cycle_finished !== prev) {
      await refreshDevices();
      if (state.selectedId && state.range !== "custom") await loadHistory();
    }
  } catch { /* chwilowy błąd sieci */ }
}

async function refreshDevices() {
  try {
    state.devices = await api("devices");
    renderDevices();
    renderOverview();
  } catch { /* chwilowy błąd sieci */ }
}

$("#btn-poll").addEventListener("click", async () => {
  await api("poll", { method: "POST" });
  toast("Rozpoczęto odpytywanie wszystkich urządzeń.");
  setTimeout(refreshStatus, 800);
});

/* ---------- ustawienia ---------- */
function openSettings() {
  renderStatus();
  $("#poll-interval").value = Math.round((state.status?.poller.interval || 300) / 60);
  $("#settings-devices").innerHTML = state.devices.map((d) => `
    <tr data-id="${esc(d.id)}">
      <td><input type="color" data-f="color" value="${esc(d.color)}"></td>
      <td><input type="text" data-f="custom_name" value="${esc(d.custom_name || "")}" placeholder="${esc(d.name)}"></td>
      <td><input type="checkbox" data-f="tracking" ${d.tracking ? "checked" : ""}></td>
      <td><input type="checkbox" data-f="hidden" ${d.hidden ? "checked" : ""}></td>
      <td><button class="btn btn-sm btn-danger" data-f="delete" title="Usuń urządzenie i jego historię">Usuń</button></td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">Brak urządzeń.</td></tr>`;
  $("#settings-dialog").showModal();
}
$("#btn-settings").addEventListener("click", openSettings);
$("#google-pill").addEventListener("click", openSettings);

$("#settings-devices").addEventListener("change", async (ev) => {
  const input = ev.target.closest("[data-f]");
  const tr = ev.target.closest("tr[data-id]");
  if (!input || !tr || input.dataset.f === "delete") return;
  const value = input.type === "checkbox" ? input.checked : input.value;
  try {
    await api(`devices/${encodeURIComponent(tr.dataset.id)}`, { method: "PATCH", body: JSON.stringify({ [input.dataset.f]: value }) });
    await refreshDevices();
  } catch (e) { toast(`Błąd: ${e.message}`); }
});
$("#settings-devices").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-f=delete]");
  if (!btn) return;
  const tr = btn.closest("tr[data-id]");
  if (!confirm("Usunąć urządzenie i całą jego historię? Wróci przy następnym odczycie listy, ale bez historii.")) return;
  await api(`devices/${encodeURIComponent(tr.dataset.id)}`, { method: "DELETE" });
  tr.remove();
  await refreshDevices();
});

$("#poll-interval-save").addEventListener("click", async () => {
  const minutes = Math.max(1, parseInt($("#poll-interval").value, 10) || 5);
  try {
    await api("settings", { method: "PUT", body: JSON.stringify({ poll_interval: minutes * 60 }) });
    toast(`Odpytywanie co ${minutes} min.`);
    refreshStatus();
  } catch (e) { toast(`Błąd: ${e.message}`); }
});

$("#secrets-upload").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await api("google/secrets", { method: "POST", body: fd });
    toast(`Wgrano sekrety${res.email ? " dla " + res.email : ""}.`);
    refreshStatus();
  } catch (e) { toast(`Błąd: ${e.message}`, 6000); }
  ev.target.value = "";
});

$("#google-disconnect").addEventListener("click", async () => {
  if (!confirm("Odłączyć konto Google? Historia zostanie, ale nowe odczyty się zatrzymają.")) return;
  await api("google", { method: "DELETE" });
  refreshStatus();
});

$("#logout").addEventListener("click", async () => {
  await api("auth/logout", { method: "POST" });
  location.reload();
});

/* ---------- łączenie konta Google ---------- */
const STEP_ORDER = ["waiting_login", "waiting_account", "waiting_pin", "finalizing", "done"];
let connectTimer = null;

function vncUrl() {
  const q = new URLSearchParams({ autoconnect: "1", resize: "scale", reconnect: "1", reconnect_delay: "1000", path: "novnc/websockify" });
  return `/novnc/vnc.html?${q}`;
}

async function startConnect() {
  $("#connect-error").hidden = true;
  $("#connect-message").textContent = "Uruchamiam przeglądarkę…";
  try {
    renderConnect(await api("google/login/start", { method: "POST" }));
  } catch (e) {
    renderConnect({ state: "error", message: "Nie można rozpocząć logowania.", error: e.message });
  }
  clearInterval(connectTimer);
  connectTimer = setInterval(pollConnect, 1500);
}

async function pollConnect() {
  try { renderConnect(await api("google/login/status")); } catch { /* ignore */ }
}

function renderConnect(st) {
  const idx = STEP_ORDER.indexOf(st.state);
  $$("#connect-steps li").forEach((li, i) => {
    li.classList.toggle("active", i === idx);
    li.classList.toggle("done", idx > i || st.state === "done");
  });
  $("#connect-message").textContent = st.message || "";
  $("#connect-error").hidden = !st.error;
  $("#connect-error").textContent = st.error ? `Szczegóły: ${st.error}` : "";
  if (["done", "error", "cancelled"].includes(st.state)) {
    clearInterval(connectTimer);
    connectTimer = null;
  }
  if (st.state === "done") {
    toast(st.message || "Połączono konto Google.");
    refreshStatus();
    setTimeout(() => { closeConnect(); refreshDevices(); }, 2500);
  }
}

function openConnect() {
  $("#settings-dialog").close();
  $("#vnc-frame").src = vncUrl();
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

/* ---------- logowanie do panelu i start ---------- */
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
  const me = await api("auth/me");
  if (!me.authenticated) return showLogin();
  $("#app-view").hidden = false;
  initMap();
  await Promise.all([refreshStatus(), refreshDevices()]);
  setInterval(refreshStatus, 5000);
  setInterval(refreshDevices, 30000);
  setInterval(renderPollPill, 1000);
}

boot();
