/* eslint-disable no-console */

/**
 * Lightweight single-file app controller:
 * - Reads URL params (?pin=lat,lon & ?stop=STOP_ID)
 * - Restores prior selection from localStorage
 * - Falls back to browser geolocation
 * - Lets user search/choose a stop (fixed search bug)
 * - Fetches and renders arrivals (ETAs)
 *
 * Assumed API contracts (unchanged from your server):
 *   GET /api/stops
 *     -> [{ stop_id: "123", name: "Main St @ 1st", lat: 43.65, lon: -79.38 }, ...]
 *
 *   GET /api/trip-updates?stop_id=123
 *     -> {
 *          stop_id: "123",
 *          arrivals: [
 *            {
 *              route_id: "501",
 *              route_short_name: "501",
 *              headsign: "To Downtown",
 *              arrival_time: 1730822400, // unix seconds (or iso); handled robustly below
 *              vehicle_id: "V123",
 *            },
 *            ...
 *          ]
 *        }
 *
 *   (Optional endpoints referenced by your existing UI:)
 *   GET /api/routes, /api/vehicles  (left untouched)
 */

//// ---------- DOM HOOKS (adjust selectors to your HTML) ----------
const els = {
  pinLabel: document.querySelector("[data-pin-label]"),
  stopLabel: document.querySelector("[data-stop-label]"),
  changeStopBtn: document.querySelector("[data-change-stop]"),
  arrivals: document.querySelector("[data-arrivals]"),
  error: document.querySelector("[data-error]"),
  searchSheet: document.querySelector("[data-search-sheet]"),
  searchInput: document.querySelector("[data-search-input]"),
  searchList: document.querySelector("[data-search-list]"),
  nearbyList: document.querySelector("[data-nearby-list]"),
  loader: document.querySelector("[data-loader]"),
};

function show(el) { if (el) el.removeAttribute("hidden"); }
function hide(el) { if (el) el.setAttribute("hidden", "true"); }
function setText(el, txt) { if (el) el.textContent = txt ?? ""; }
function clear(el) { if (el) el.innerHTML = ""; }

//// ---------- URL PARAMS & STORAGE ----------
function parseUrlParams() {
  const sp = new URLSearchParams(window.location.search);
  const pin = sp.get("pin"); // "lat,lon"
  const stop = sp.get("stop"); // stop_id
  let pinCoords = null;

  if (pin) {
    const parts = pin.split(",").map((s) => s.trim());
    if (parts.length === 2) {
      const lat = Number(parts[0]);
      const lon = Number(parts[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        pinCoords = { lat, lon };
      }
    }
  }

  return { pin: pinCoords, stopId: stop || null };
}

const STORAGE_KEYS = {
  PIN: "app.pin",
  STOP: "app.stopId",
};

function savePin(pin) {
  try { localStorage.setItem(STORAGE_KEYS.PIN, JSON.stringify(pin)); } catch {}
}
function loadPin() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PIN);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveStopId(stopId) {
  try { localStorage.setItem(STORAGE_KEYS.STOP, String(stopId)); } catch {}
}
function loadStopId() {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.STOP);
    return v || null;
  } catch { return null; }
}

//// ---------- GEO / DISTANCE ----------
function haversineKm(a, b) {
  // a: {lat, lon}, b: {lat, lon}
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

function formatDistanceKm(km) {
  if (!Number.isFinite(km)) return "";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

//// ---------- API ----------
async function api(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function getStops() {
  return api("/api/stops");
}

async function getArrivals(stopId) {
  const qs = new URLSearchParams({ stop_id: String(stopId) });
  return api(`/api/trip-updates?${qs.toString()}`);
}

//// ---------- SEARCH / CHOOSER (fixed) ----------
/**
 * Safe string includes: case-insensitive, guards nulls.
 */
function includesI(haystack, needle) {
  if (!haystack || !needle) return false;
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

/**
 * Filter & sort stops by search text vs. current pin.
 * Replaces the broken `includes(...a,b)=>` code.
 */
function filterAndRankStops(stops, searchText, pin) {
  const q = (searchText || "").trim();
  const hasQ = q.length > 0;

  const filtered = stops.filter((s) => {
    if (!hasQ) return true;
    return (
      includesI(s.name, q) ||
      includesI(s.stop_id, q)
    );
  });

  if (pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lon)) {
    filtered.forEach((s) => {
      s.__dist_km = haversineKm(pin, { lat: s.lat, lon: s.lon });
    });
    filtered.sort((a, b) => (a.__dist_km ?? Infinity) - (b.__dist_km ?? Infinity));
  } else if (hasQ) {
    // Tie-breaker: lexical by name when searching without a pin
    filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  return filtered;
}

function renderStopsList(container, stops, onPick) {
  clear(container);
  const frag = document.createDocumentFragment();
  stops.slice(0, 100).forEach((s) => {
    const li = document.createElement("button");
    li.type = "button";
    li.className = "stop-row";
    li.style.cssText = "display:flex;justify-content:space-between;align-items:center;width:100%;padding:0.5rem 0;border-bottom:1px solid #eee;text-align:left;";
    const left = document.createElement("div");
    left.innerHTML = `<div style="font-weight:600">${escapeHtml(s.name)}</div><div style="opacity:.7;font-size:.9em">#${escapeHtml(s.stop_id)}</div>`;
    const right = document.createElement("div");
    right.style.opacity = ".8";
    right.textContent = s.__dist_km != null ? formatDistanceKm(s.__dist_km) : "";
    li.appendChild(left);
    li.appendChild(right);
    li.addEventListener("click", () => onPick(s));
    frag.appendChild(li);
  });
  container.appendChild(frag);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

//// ---------- ARRIVALS RENDER ----------
function parseToEpochSeconds(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    // Assume already seconds if not huge; accept ms if too large
    return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

function minutesFromNow(epochSec) {
  if (!Number.isFinite(epochSec)) return null;
  const now = Math.round(Date.now() / 1000);
  const delta = epochSec - now; // seconds
  return Math.floor(delta / 60);
}

function formatEtaMin(min) {
  if (min == null) return "—";
  if (min < 0) return "due";
  if (min === 0) return "due";
  if (min === 1) return "1 min";
  return `${min} min`;
}

function renderArrivals(listEl, payload) {
  clear(listEl);
  const { arrivals = [] } = payload || {};
  if (!arrivals.length) {
    listEl.innerHTML = `<div style="padding:.75rem 0;opacity:.8">No upcoming trips.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  arrivals.forEach((a) => {
    const whenSec = parseToEpochSeconds(a.arrival_time);
    const min = minutesFromNow(whenSec);
    const row = document.createElement("div");
    row.className = "arrival-row";
    row.style.cssText = "display:flex;gap:.75rem;align-items:center;padding:.5rem 0;border-bottom:1px solid #eee;";
    row.innerHTML = `
      <div style="min-width:3rem;font-weight:700">${escapeHtml(a.route_short_name ?? a.route_id ?? "")}</div>
      <div style="flex:1">
        <div style="font-weight:600">${escapeHtml(a.headsign ?? "")}</div>
        ${whenSec ? `<div style="opacity:.7;font-size:.9em">${new Date(whenSec * 1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>` : ""}
      </div>
      <div style="min-width:3.5rem;text-align:right;font-weight:700">${formatEtaMin(min)}</div>
    `;
    frag.appendChild(row);
  });
  listEl.appendChild(frag);
}

//// ---------- APP STATE ----------
const state = {
  pin: /** @type {{lat:number, lon:number}|null} */ (null),
  stopId: /** @type {string|null} */ (null),
  stops: /** @type {Array<any>} */ ([]),
  arrivalsTimer: /** @type {number|undefined} */ (undefined),
};

function updatePinLabel() {
  if (!els.pinLabel) return;
  if (state.pin) setText(els.pinLabel, `${state.pin.lat.toFixed(5)}, ${state.pin.lon.toFixed(5)}`);
  else setText(els.pinLabel, "No pin");
}

function updateStopLabel() {
  if (!els.stopLabel) return;
  const s = state.stops.find((x) => String(x.stop_id) === String(state.stopId));
  setText(els.stopLabel, s ? `${s.name} (#${s.stop_id})` : (state.stopId ? `Stop #${state.stopId}` : "No stop"));
}

function startArrivalsRefresh() {
  if (state.arrivalsTimer) window.clearInterval(state.arrivalsTimer);
  const tick = async () => {
    if (!state.stopId) return;
    try {
      hide(els.error);
      show(els.loader);
      const payload = await getArrivals(state.stopId);
      renderArrivals(els.arrivals, payload);
    } catch (e) {
      console.error(e);
      setText(els.error, `Failed to load arrivals: ${e.message ?? e}`);
      show(els.error);
    } finally {
      hide(els.loader);
    }
  };
  // Initial + every 15s
  tick();
  state.arrivalsTimer = window.setInterval(tick, 15000);
}

//// ---------- SEARCH SHEET UX ----------
function openSearchSheet() { show(els.searchSheet); if (els.searchInput) els.searchInput.focus(); }
function closeSearchSheet() { hide(els.searchSheet); if (els.searchInput) els.searchInput.value = ""; }

function wireSearch(stops) {
  if (!els.searchInput || !els.searchList || !els.nearbyList) return;

  const renderNearby = () => {
    const ranked = filterAndRankStops(stops, "", state.pin);
    renderStopsList(els.nearbyList, ranked.slice(0, 20), onPickStop);
  };

  const onPickStop = (stop) => {
    state.stopId = String(stop.stop_id);
    saveStopId(state.stopId);
    updateStopLabel();
    closeSearchSheet();
    startArrivalsRefresh();
  };

  els.searchInput.addEventListener("input", () => {
    const q = els.searchInput.value || "";
    const ranked = filterAndRankStops(stops, q, state.pin);
    renderStopsList(els.searchList, ranked.slice(0, 100), onPickStop);
  });

  renderNearby();
  renderStopsList(els.searchList, filterAndRankStops(stops, "", state.pin).slice(0, 100), onPickStop);
}

//// ---------- BOOT ----------
async function boot() {
  try {
    show(els.loader);
    hide(els.error);

    // 1) URL params first
    const { pin: urlPin, stopId: urlStop } = parseUrlParams();
    if (urlPin) {
      state.pin = urlPin;
      savePin(urlPin);
    }

    // 2) Load stops once
    state.stops = await getStops();

    // 3) Pin fallback chain
    if (!state.pin) {
      const stored = loadPin();
      if (stored) {
        state.pin = stored;
      } else {
        // Geolocate (non-blocking)
        await new Promise((resolve) => {
          if (!navigator.geolocation) return resolve();
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              state.pin = { lat: pos.coords.latitude, lon: pos.coords.longitude };
              savePin(state.pin);
              resolve();
            },
            () => resolve(),
            { enableHighAccuracy: true, timeout: 7000, maximumAge: 30000 }
          );
        });
      }
    }

    // 4) Stop fallback chain
    state.stopId = urlStop || loadStopId() || null;
    // If still no stop, choose nearest to pin (if we have one)
    if (!state.stopId && state.pin) {
      const ranked = filterAndRankStops(state.stops, "", state.pin);
      if (ranked.length) {
        state.stopId = String(ranked[0].stop_id);
        saveStopId(state.stopId);
      }
    }

    // 5) Wire UI and kick off arrivals
    updatePinLabel();
    updateStopLabel();
    wireSearch(state.stops);

    if (state.stopId) {
      startArrivalsRefresh();
    } else {
      // Encourage user to pick a stop
      setText(els.error, "Select a stop to see arrivals.");
      show(els.error);
    }
  } catch (e) {
    console.error(e);
    setText(els.error, `Failed to initialize: ${e.message ?? e}`);
    show(els.error);
  } finally {
    hide(els.loader);
  }
}

//// ---------- EVENTS ----------
if (els.changeStopBtn) {
  els.changeStopBtn.addEventListener("click", () => openSearchSheet());
}
if (els.searchSheet) {
  // Close the sheet if clicking a backdrop region labeled data-search-close
  els.searchSheet.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t && t.matches?.("[data-search-close]")) closeSearchSheet();
  });
}

document.addEventListener("DOMContentLoaded", boot);
