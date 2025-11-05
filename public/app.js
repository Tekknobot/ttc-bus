/* eslint-disable no-console */

// ======= DOM =======
const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  spin: $("spin"),
  btnRefresh: $("btnRefresh"),
  where: $("where"),
  err: $("err"),
  list: $("list"),
  foot: $("foot"),
};

// ======= Config knobs (tweak freely) =======
const INCLUDE_SIBLING_WITHIN_M = 120;   // opposite platform etc.
const VEHICLE_FALLBACK_WITHIN_M = 400;  // proximity fallback radius
const REFRESH_MS = 10000;               // ~10s

// ======= Storage keys =======
const K = {
  PIN: "ttc.pin",
  STOP: "ttc.stopId",
};

// ======= State =======
const S = {
  pin: /** @type {{lat:number, lon:number}|null} */ (null),
  stopId: /** @type {string|null} */ (null),
  stops: /** @type {Array<any>} */ ([]),
  timer: /** @type {number|undefined} */ (undefined),
};

// ======= Utils =======
function show(el) { if (el) el.style.display = ""; }
function hide(el) { if (el) el.style.display = "none"; }
function setText(el, txt) { if (el) el.textContent = txt ?? ""; }
function clear(el) { if (el) el.innerHTML = ""; }
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000; // meters
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtDist(m) {
  if (!Number.isFinite(m)) return "";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m/1000).toFixed(1)} km`;
}

function parseToEpochSeconds(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
}
function minsFromNow(epochSec) {
  if (!Number.isFinite(epochSec)) return null;
  const now = Math.round(Date.now()/1000);
  return Math.floor((epochSec - now)/60);
}
function etaClass(min) {
  if (min == null) return "";
  if (min <= 3) return "good";
  if (min <= 7) return "warn";
  return "";
}
function fmtEta(min) {
  if (min == null) return "—";
  if (min <= 0) return "due";
  if (min === 1) return "1 min";
  return `${min} min`;
}

// ======= URL / Storage =======
function getParams() {
  const sp = new URLSearchParams(window.location.search);
  const pinStr = sp.get("pin");
  const stopId = sp.get("stop");
  let pin = null;
  if (pinStr) {
    const [a,b] = pinStr.split(",").map(x => x.trim());
    const lat = Number(a), lon = Number(b);
    if (Number.isFinite(lat) && Number.isFinite(lon)) pin = { lat, lon };
  }
  return { pin, stopId: stopId || null };
}
function savePin(pin) {
  try { localStorage.setItem(K.PIN, JSON.stringify(pin)); } catch {}
}
function loadPin() {
  try { const raw = localStorage.getItem(K.PIN); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveStopId(id) {
  try { localStorage.setItem(K.STOP, String(id)); } catch {}
}
function loadStopId() {
  try { return localStorage.getItem(K.STOP) || null; } catch { return null; }
}

// ======= API =======
async function api(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
const getStops = () => api("/api/stops");
const getArrivals = (stopId) => api(`/api/trip-updates?stop_id=${encodeURIComponent(String(stopId))}`);
const getVehicles = () => api("/api/vehicles"); // for proximity fallback

// ======= Core logic =======
function nearestStop(stops, pin) {
  if (!pin || !stops?.length) return null;
  let best = null, bestD = Infinity;
  for (const s of stops) {
    const d = haversineMeters(pin, { lat: s.lat, lon: s.lon });
    if (d < bestD) { best = s; bestD = d; }
  }
  return best ? { stop: best, distM: bestD } : null;
}
function siblingStops(stops, anchor, pin) {
  // All stops within INCLUDE_SIBLING_WITHIN_M of anchor; sort by distance to pin
  const around = [];
  for (const s of stops) {
    const d = haversineMeters({ lat: anchor.lat, lon: anchor.lon }, { lat: s.lat, lon: s.lon });
    if (d <= INCLUDE_SIBLING_WITHIN_M) {
      const dp = pin ? haversineMeters(pin, { lat: s.lat, lon: s.lon }) : Infinity;
      around.push({ stop: s, dFromAnchor: d, dFromPin: dp });
    }
  }
  around.sort((a,b) => a.dFromPin - b.dFromPin);
  // Cap to a few to avoid hammering the API
  return around.slice(0, 3).map(x => x.stop);
}

async function chooseStop() {
  // 1) URL overrides
  const { pin: urlPin, stopId: urlStop } = getParams();
  if (urlPin) { S.pin = urlPin; savePin(S.pin); }

  // 2) Stops catalog
  S.stops = await getStops();

  // 3) Pin fallbacks
  if (!S.pin) {
    const stored = loadPin();
    if (stored) {
      S.pin = stored;
    } else {
      await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve();
        navigator.geolocation.getCurrentPosition(
          (pos) => { S.pin = { lat: pos.coords.latitude, lon: pos.coords.longitude }; savePin(S.pin); resolve(); },
          () => resolve(),
          { enableHighAccuracy: true, timeout: 7000, maximumAge: 30000 }
        );
      });
    }
  }

  // 4) Stop fallbacks
  S.stopId = urlStop || loadStopId();
  if (!S.stopId) {
    const best = S.pin ? nearestStop(S.stops, S.pin) : null;
    if (best?.stop) {
      S.stopId = String(best.stop.stop_id);
      saveStopId(S.stopId);
    }
  }
}

function renderWhere() {
  if (!els.where) return;
  const pinTxt = S.pin ? `${S.pin.lat.toFixed(5)}, ${S.pin.lon.toFixed(5)}` : "—";
  const cur = S.stops.find(s => String(s.stop_id) === String(S.stopId));
  const stopTxt = cur ? `${escapeHtml(cur.name)} (#${escapeHtml(cur.stop_id)})` : "No stop";
  let distTxt = "";
  if (S.pin && cur) {
    const d = haversineMeters(S.pin, { lat: cur.lat, lon: cur.lon });
    distTxt = ` • <span class="meta">nearest:</span> <span class="dist">${fmtDist(d)}</span>`;
  }
  els.where.innerHTML = `${pinTxt} • ${stopTxt}${distTxt}`;
}

function renderFootStamp() {
  const ts = new Date();
  setText(els.foot, `Updated ${ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
}

function rowHTML(a) {
  const whenSec = parseToEpochSeconds(a.arrival_time);
  const min = minsFromNow(whenSec);
  const klass = etaClass(min);
  const route = escapeHtml(a.route_short_name ?? a.route_id ?? "");
  const head = escapeHtml(a.headsign ?? "");
  const sub = a.__sub ?? "";
  return `
    <li>
      <div class="row">
        <div>
          <div style="font-weight:700; letter-spacing:.2px">${route} ${head ? "· " + head : ""}</div>
          <div class="sub">${sub}</div>
        </div>
        <div class="eta ${klass}">${fmtEta(min)}</div>
      </div>
    </li>
  `;
}

function renderList(items) {
  clear(els.list);
  if (!items?.length) {
    els.list.innerHTML = `<div class="empty">No upcoming trips.</div>`;
    return;
  }
  els.list.innerHTML = items.map(rowHTML).join("");
}

async function fetchMergedArrivals() {
  // Determine anchor stop + siblings
  const anchor = S.stops.find(s => String(s.stop_id) === String(S.stopId));
  if (!anchor) return [];

  const sibs = siblingStops(S.stops, anchor, S.pin);
  const ids = [anchor.stop_id, ...sibs.map(s => s.stop_id)]
    .map(String)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  // Fetch arrivals for each (in parallel)
  const payloads = await Promise.allSettled(ids.map(id => getArrivals(id)));
  const arrivals = [];
  payloads.forEach((p, idx) => {
    if (p.status !== "fulfilled") return;
    const stopId = ids[idx];
    const stop = S.stops.find(s => String(s.stop_id) === String(stopId));
    (p.value?.arrivals ?? []).forEach(a => {
      arrivals.push({
        ...a,
        __stop_id: stopId,
        __sub: stop ? `At stop #${escapeHtml(stop.stop_id)}` : `At stop #${escapeHtml(stopId)}`
      });
    });
  });

  // Sort by soonest
  arrivals.sort((a,b) => {
    const ma = minsFromNow(parseToEpochSeconds(a.arrival_time)) ?? Infinity;
    const mb = minsFromNow(parseToEpochSeconds(b.arrival_time)) ?? Infinity;
    return ma - mb;
  });

  // Vehicle proximity fallback if nothing found
  if (!arrivals.length && S.pin) {
    try {
      const vehicles = await getVehicles();
      const near = (vehicles || []).map(v => {
        const d = haversineMeters(S.pin, { lat: v.lat, lon: v.lon });
        return { v, d };
      }).filter(x => x.d <= VEHICLE_FALLBACK_WITHIN_M)
        .sort((a,b) => a.d - b.d)
        .slice(0, 6);

      near.forEach(({ v, d }) => {
        arrivals.push({
          route_id: v.route_id,
          route_short_name: v.route_short_name ?? v.route_id,
          headsign: v.headsign ?? v.label ?? "",
          arrival_time: null, // unknown -> "—"
          __stop_id: null,
          __sub: `Nearby vehicle — ${fmtDist(d)} away`
        });
      });
    } catch (e) {
      // ignore fallback errors; main arrivals are already empty
    }
  }

  return arrivals;
}

async function tick(refreshCause = "") {
  try {
    hide(els.err);
    show(els.spin);
    setText(els.status, "Live");

    if (!S.stopId) {
      renderList([]);
      setText(els.err, "Location required. Enable location, or pass ?pin=LAT,LON.");
      show(els.err);
      return;
    }

    renderWhere();
    const items = await fetchMergedArrivals();
    renderList(items);
    renderFootStamp();
  } catch (e) {
    console.error(e);
    setText(els.status, "Offline");
    setText(els.err, `Error: ${e.message ?? e}`);
    show(els.err);
  } finally {
    hide(els.spin);
  }
}

function startAutoRefresh() {
  if (S.timer) window.clearInterval(S.timer);
  S.timer = window.setInterval(() => tick("auto"), REFRESH_MS);
}

// ======= Boot =======
async function boot() {
  try {
    hide(els.err);
    show(els.spin);
    show(els.btnRefresh);

    await chooseStop();
    renderWhere();

    await tick("boot");
    startAutoRefresh();
  } catch (e) {
    console.error(e);
    setText(els.err, `Failed to initialize: ${e.message ?? e}`);
    show(els.err);
    setText(els.status, "Offline");
  } finally {
    hide(els.spin);
  }
}

// ======= Events =======
document.addEventListener("DOMContentLoaded", boot);
if (els.btnRefresh) {
  els.btnRefresh.addEventListener("click", () => tick("manual"));
}
