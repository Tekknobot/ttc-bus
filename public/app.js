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

// ======= Config =======
const INCLUDE_SIBLING_WITHIN_M = 120;
const VEHICLE_FALLBACK_WITHIN_M = 400;
const REFRESH_MS = 10000;

// ======= Storage keys =======
const K = { PIN: "ttc.pin", STOP: "ttc.stopId", ROUTE: "ttc.route" };

// ======= State =======
const S = {
  pin: null,          // {lat, lon}
  stopId: null,       // string
  route: null,        // string (short name or route_id)
  stops: [],          // [{ stop_id, name, lat, lon }]
  siblings: [],       // sibling group (ids) including anchor
  siblingIdx: 0,      // index into siblings
  timer: undefined,
};

// ======= Utils =======
function show(el) { if (el) el.style.display = ""; }
function hide(el) { if (el) el.style.display = "none"; }
function setText(el, txt) { if (el) el.textContent = txt ?? ""; }
function clear(el) { if (el) el.innerHTML = ""; }
function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
function titleCase(s) {
  return String(s).toLowerCase().replace(/\b([a-z])/g, (_,c)=>c.toUpperCase());
}

function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtDist(m) { if (!Number.isFinite(m)) return ""; return m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`; }

function parseToEpochSeconds(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? Math.round(v/1000) : Math.round(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.round(t/1000) : null;
}
function minsFromNow(epochSec) {
  if (!Number.isFinite(epochSec)) return null;
  const now = Math.round(Date.now()/1000);
  return Math.floor((epochSec - now)/60);
}
function etaClass(min) { if (min == null) return ""; if (min <= 3) return "good"; if (min <= 7) return "warn"; return ""; }
function fmtEta(min) { if (min == null) return "—"; if (min <= 0) return "due"; if (min === 1) return "1 min"; return `${min} min`; }

// Extract a “street name” from TTC stop names like “DUNDAS ST WEST AT LANSDOWNE AVE”
function extractStreet(stopName) {
  if (!stopName) return null;
  const s = String(stopName);
  const splitters = [" AT ", " @ ", " - ", " / "];
  for (const sp of splitters) {
    const i = s.indexOf(sp);
    if (i > 0) return titleCase(s.slice(0, i).trim());
  }
  return titleCase(s.trim());
}

// ======= URL / Storage =======
function getParams() {
  const sp = new URLSearchParams(window.location.search);
  const stopId = sp.get("stop") || null;
  const pinStr = sp.get("pin");
  const route = sp.get("route"); // short name or route_id (e.g., "72")
  let pin = null;
  if (pinStr) {
    const [a,b] = pinStr.split(",").map(x => x.trim());
    const lat = Number(a), lon = Number(b);
    if (Number.isFinite(lat) && Number.isFinite(lon)) pin = { lat, lon };
  }
  return { stopId, pin, route };
}
function savePin(pin) { try { localStorage.setItem(K.PIN, JSON.stringify(pin)); } catch {} }
function loadPin() { try { const raw = localStorage.getItem(K.PIN); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function saveStopId(id) { try { localStorage.setItem(K.STOP, String(id)); } catch {} }
function loadStopId() { try { return localStorage.getItem(K.STOP) || null; } catch { return null; } }
function saveRoute(route) { try { if(route) localStorage.setItem(K.ROUTE, String(route)); else localStorage.removeItem(K.ROUTE);} catch {} }
function loadRoute() { try { return localStorage.getItem(K.ROUTE) || null; } catch { return null; } }

// ======= API =======
async function api(path) { const r = await fetch(path,{credentials:"same-origin"}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); }
const getStops   = () => api("/api/stops");
const getArrivals= (stopId) => api(`/api/trip-updates?stop_id=${encodeURIComponent(String(stopId))}`);
const getVehicles= () => api("/api/vehicles"); // simplified payload from server

// ======= Core helpers =======
function nearestStop(stops, pin) {
  if (!pin || !stops?.length) return null;
  let best = null, bestD = Infinity;
  for (const s of stops) {
    const d = haversineMeters(pin, { lat: s.lat, lon: s.lon });
    if (d < bestD) { best = s; bestD = d; }
  }
  return best ? { stop: best, distM: bestD } : null;
}
function computeSiblingGroup(stops, anchor, pin) {
  if (!anchor) return [];
  // all stops within radius, sorted by distance to pin (or anchor if no pin)
  const center = pin || { lat: anchor.lat, lon: anchor.lon };
  const group = [];
  for (const s of stops) {
    const d = haversineMeters({ lat: anchor.lat, lon: anchor.lon }, { lat: s.lat, lon: s.lon });
    if (d <= INCLUDE_SIBLING_WITHIN_M) {
      const dPin = haversineMeters(center, { lat: s.lat, lon: s.lon });
      group.push({ id: String(s.stop_id), dPin });
    }
  }
  // ensure anchor is included even if rounding issues
  if (!group.some(g => g.id === String(anchor.stop_id))) {
    const dPin = haversineMeters(center, { lat: anchor.lat, lon: anchor.lon });
    group.push({ id: String(anchor.stop_id), dPin });
  }
  group.sort((a,b) => a.dPin - b.dPin);
  // unique ids
  const unique = [];
  const seen = new Set();
  for (const g of group) {
    if (!seen.has(g.id)) { unique.push(g.id); seen.add(g.id); }
  }
  return unique;
}
function indexOfSibling(siblings, stopId) {
  const i = siblings.findIndex(id => String(id) === String(stopId));
  return i >= 0 ? i : 0;
}
function setStopAndRefresh(newStopId) {
  S.stopId = String(newStopId);
  saveStopId(S.stopId);
  // recompute group to keep UI consistent
  const anchor = S.stops.find(s => String(s.stop_id) === S.stopId);
  S.siblings = computeSiblingGroup(S.stops, anchor, S.pin);
  S.siblingIdx = indexOfSibling(S.siblings, S.stopId);
  renderWhere(); // update header controls immediately
  tick();        // refresh arrivals now
}

// ======= Render =======
function renderWhere() {
  // Stack: Stop (bold), Street, Nearest — plus sibling switcher (when available)
  const cur = S.stops.find(s => String(s.stop_id) === String(S.stopId));
  const stopLine = cur
    ? `${escapeHtml(cur.name)} (#${escapeHtml(cur.stop_id)})`
    : "No stop selected";
  const streetLine = cur ? extractStreet(cur.name) : null;

  let nearestLine = null;
  if (S.pin && cur) {
    const d = haversineMeters(S.pin, { lat: cur.lat, lon: cur.lon });
    nearestLine = fmtDist(d);
  }

  const hasSiblings = S.siblings.length > 1;
  const idxLabel = hasSiblings ? `(${S.siblingIdx + 1}/${S.siblings.length})` : "";

  // Build stacked rows; only render rows that exist
  const rows = [];
  rows.push(`<div style="font-weight:700">${stopLine}</div>`);
  if (streetLine) {
    rows.push(`<div class="meta" style="color:var(--muted)">Street: <span style="color:inherit">${escapeHtml(streetLine)}</span></div>`);
  }
  if (nearestLine) {
    rows.push(`<div class="meta" style="color:var(--muted)">Nearest: <span class="dist" style="font-weight:800;color:inherit">${nearestLine}</span></div>`);
  }

  // Sibling switcher UI (Prev/Next)
  const switcher = hasSiblings ? `
    <div style="display:flex; gap:8px; margin-top:6px">
      <button id="sibPrev" type="button" aria-label="Previous nearby stop" style="padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);cursor:pointer">Prev</button>
      <div class="meta" style="align-self:center;color:var(--muted)">${idxLabel}</div>
      <button id="sibNext" type="button" aria-label="Next nearby stop" style="padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);cursor:pointer">Next</button>
    </div>
  ` : "";

  // Single child container so the parent .where (flex-row) won’t try to lay out multiple columns
  els.where.innerHTML = `
    <div style="
      display:grid;
      grid-template-columns: 1fr;
      row-gap: 2px;
      line-height: 1.35;
      min-width: 0;
      word-break: break-word;
    ">
      ${rows.join("")}
      ${switcher}
    </div>
  `;

  // Wire buttons (event delegation safe to re-run)
  if (hasSiblings) {
    const prevBtn = document.getElementById("sibPrev");
    const nextBtn = document.getElementById("sibNext");
    if (prevBtn) prevBtn.onclick = () => {
      if (!S.siblings.length) return;
      S.siblingIdx = (S.siblingIdx - 1 + S.siblings.length) % S.siblings.length;
      setStopAndRefresh(S.siblings[S.siblingIdx]);
    };
    if (nextBtn) nextBtn.onclick = () => {
      if (!S.siblings.length) return;
      S.siblingIdx = (S.siblingIdx + 1) % S.siblings.length;
      setStopAndRefresh(S.siblings[S.siblingIdx]);
    };
  }
}

function renderFootStamp() {
  const ts = new Date();
  setText(els.foot, `Updated ${ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
}

function rowHTML(a) {
  const whenSec = parseToEpochSeconds(a.arrival_time);
  const min = minsFromNow(whenSec);
  const klass = etaClass(min);

  // no route number; just optional headsign and the location subline
  const head = escapeHtml(a.headsign || "");
  const sub  = a.__sub ?? "";

  return `
    <li>
      <div class="row">
        <div>
          <div style="font-weight:700; letter-spacing:.2px">${head}</div>
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

// ======= Fetch predictions (with sibling + vehicle fallback) =======
async function fetchMergedArrivals() {
  const anchor = S.stops.find(s => String(s.stop_id) === String(S.stopId));
  if (!anchor) return [];

  // Ensure sibling group is available
  if (!S.siblings.length) {
    S.siblings = computeSiblingGroup(S.stops, anchor, S.pin);
    S.siblingIdx = indexOfSibling(S.siblings, S.stopId);
  }

  const ids = S.siblings.length ? S.siblings : [String(anchor.stop_id)];

  // Fetch each stop's arrivals
  const results = await Promise.allSettled(ids.map(id => getArrivals(id)));
  const arrivals = [];
  results.forEach((p, idx) => {
    if (p.status !== "fulfilled") return;
    const stopId = ids[idx];
    const stop = S.stops.find(s => String(s.stop_id) === String(stopId));
    (p.value?.arrivals ?? []).forEach(a => {
      if (!routeMatches(S.route, a)) return; // filter by pinned route if present
      const street = stop ? extractStreet(stop.name) : null;
      arrivals.push({
        ...a,
        __sub: stop
          ? `At stop #${escapeHtml(stop.stop_id)}${street ? ` — ${escapeHtml(street)}` : ""}`
          : `At stop #${escapeHtml(stopId)}`
      });
    });
  });

  arrivals.sort((a,b) => {
    const ma = minsFromNow(parseToEpochSeconds(a.arrival_time)) ?? Infinity;
    const mb = minsFromNow(parseToEpochSeconds(b.arrival_time)) ?? Infinity;
    return ma - mb;
  });

  // Vehicle fallback if still empty (respect pinned route if present)
  if (!arrivals.length && S.pin) {
    try {
      const vehicles = await getVehicles();
      const near = (vehicles || [])
        .filter(v => routeMatches(S.route, v))
        .map(v => ({ v, d: haversineMeters(S.pin, { lat: v.lat, lon: v.lon }) }))
        .filter(x => x.d <= VEHICLE_FALLBACK_WITHIN_M)
        .sort((a,b) => a.d - b.d)
        .slice(0, 6);

      near.forEach(({ v, d }) => {
        arrivals.push({
          route_id: v.route_id,
          route_short_name: v.route_short_name ?? v.route_id,
          headsign: v.headsign ?? v.label ?? "",
          arrival_time: null,
          __sub: `Nearby vehicle — ${fmtDist(d)} away`,
        });
      });
    } catch { /* ignore */ }
  }

  return arrivals;
}

// ======= Tick / Refresh =======
async function tick() {
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
  S.timer = window.setInterval(() => tick(), REFRESH_MS);
}

// ======= Boot =======
async function boot() {
  try {
    hide(els.err);
    show(els.spin);
    show(els.btnRefresh);

    // URL overrides first
    const { stopId: urlStop, pin: urlPin, route: urlRoute } = getParams();
    if (urlPin) { S.pin = urlPin; savePin(S.pin); }
    if (urlRoute) { S.route = urlRoute; saveRoute(S.route); }

    // Load stops catalog
    S.stops = await getStops();

    // Route fallback (persisted)
    if (!S.route) {
      const r = loadRoute();
      if (r) S.route = r;
    }

    // Pin fallback chain
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

    // Stop fallback chain
    S.stopId = urlStop || loadStopId();
    if (!S.stopId && S.pin) {
      const best = nearestStop(S.stops, S.pin);
      if (best?.stop) { S.stopId = String(best.stop.stop_id); saveStopId(S.stopId); }
    }

    // Build initial sibling group
    const anchor = S.stops.find(s => String(s.stop_id) === String(S.stopId));
    S.siblings = computeSiblingGroup(S.stops, anchor, S.pin);
    S.siblingIdx = indexOfSibling(S.siblings, S.stopId);

    renderWhere();
    await tick();
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

document.addEventListener("DOMContentLoaded", boot);
if (els.btnRefresh) els.btnRefresh.addEventListener("click", () => tick());
