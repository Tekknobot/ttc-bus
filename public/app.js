// ---------- DOM helpers ----------
const $ = s => document.querySelector(s);
function must(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing DOM element: ${sel}`);
  return el;
}

// ---------- geo / math ----------
const toRad = d => d * Math.PI / 180;
const haversine = (a,b,c,d)=>{
  const R=6371000, dLat=toRad(c-a), dLon=toRad(d-b);
  const A=Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(Math.abs(dLon)/2)**2;
  return 2*R*Math.atan2(Math.sqrt(A),Math.sqrt(1-A));
};
const fmtKm = m => m < 1000 ? `${Math.round(m)} metres` : `${(m/1000).toFixed(2)} kilometres`;

// ---------- time (server skew) ----------
let _clockSkewMs = 0; // server_now - client_now
async function syncServerTime(){
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const { ts } = await r.json(); // ts = server ms epoch
    _clockSkewMs = Number(ts) - Date.now();
  } catch { /* ignore; fall back to device time */ }
}
const nowSec = () => Math.floor((Date.now() + _clockSkewMs) / 1000);

// ---------- robust fetch ----------
async function fetchJSON(url){
  const r = await fetch(url, { cache: 'no-store' });
  const text = await r.text();
  try {
    const json = JSON.parse(text);
    if (!r.ok) throw new Error(json.error || r.statusText);
    return json;
  } catch (e) {
    throw new Error(`HTTP ${r.status}: ${text.slice(0,200)}`);
  }
}

// ---------- API wrappers ----------
async function getStops(){ return fetchJSON('/api/stops'); }
async function getRoutes(){ return fetchJSON('/api/routes'); }
async function getTrips(stopIds){
  const qs = encodeURIComponent(stopIds.join(','));
  return fetchJSON('/api/trip-updates?stop='+qs);
}

// ---------- state ----------
let nearest = null, lastStamp = null, user = null;

// Lookups
const routesById = Object.create(null);
const routesByShort = Object.create(null);
const stopsById = Object.create(null);

function buildRouteIndexes(routes) {
  for (const r of routes || []) {
    if (r.route_id != null) routesById[String(r.route_id)] = r;
    if (r.short_name) routesByShort[String(r.short_name)] = r;
  }
}
function buildStopIndex(stops) {
  for (const s of stops || []) {
    if (s.stop_id != null) stopsById[String(s.stop_id)] = s;
  }
}

// Prefer "47 Lansdowne" if we can, else best available
function routeLabel(routeId) {
  if (routeId == null) return 'Route';
  const key = String(routeId);
  const r = routesById[key] || routesByShort[key];
  if (!r) return key;
  if (r.short_name && r.long_name) return `${r.short_name} ${r.long_name}`;
  return r.short_name || r.long_name || key;
}

// ---------- logic ----------
function pickNearest(stops, lat, lon){
  let best=null;
  for(const s of stops){
    const d = haversine(lat,lon,s.lat,s.lon);
    if(!best || d < best.d) best = {...s, d};
  }
  return { best };
}

function renderNext(next){
  const ul = must('#list');
  ul.innerHTML = '';

  if (!next) {
    ul.innerHTML = `<li class="empty">No live prediction for this stop right now.</li>`;
    return;
  }

  const etaMin = Math.max(0, Math.round(next.eta / 60));
  const cls = etaMin <= 3 ? 'eta good' : (etaMin <= 7 ? 'eta warn' : 'eta');
  const label = routeLabel(next.routeId);
  const li = document.createElement('li');
  li.innerHTML = `
    <div class="row">
      <div class="${cls}">${etaMin} min</div>
      <span class="pill" title="${label}">${label}</span>
    </div>
    <div class="sub">At stop #${next.stopId}</div>
  `;
  ul.appendChild(li);
}

// ---------- debug overlay ----------
const debug = new URLSearchParams(location.search).get('debug') === '1';
function setDebug(text){
  if (!debug) return;
  let dv = document.getElementById('debug');
  if (!dv) {
    dv = document.createElement('div');
    dv.id = 'debug';
    dv.style.cssText = 'padding:8px 16px;color:#94a3b8;font-size:12px';
    const header = document.querySelector('.header');
    header && header.insertAdjacentElement('afterend', dv);
  }
  dv.textContent = text;
}

// ---------- location acquisition (mobile-robust) ----------
const ACCURACY_GOAL_M = 80;     // aim for ≤ 80 m
const MAX_WAIT_MS     = 15000;  // give GPS up to 15s
const BAD_NEAREST_M   = 300;    // if nearest stop farther than this, treat as wrong fix

function locationErrorHint(message){
  const err = must('#err');
  let hint = message || 'Location error.';
  hint += ' If you are on iPhone, enable “Precise Location” for this site. Ensure the page is loaded over HTTPS.';
  err.textContent = hint;
}

function getPrecisePosition(){
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation not available (use HTTPS).'));
      return;
    }
    let best = null;
    const start = Date.now();

    const onSuccess = (pos) => {
      best = (!best || pos.coords.accuracy < best.coords.accuracy) ? pos : best;
      const good = pos.coords.accuracy <= ACCURACY_GOAL_M;
      if (good || (Date.now() - start) > MAX_WAIT_MS) {
        navigator.geolocation.clearWatch(wid);
        resolve(best || pos);
      }
    };
    const onError = (e) => {
      // Keep waiting unless fatal; if we already have a best, resolve it after timeout
      if ((Date.now() - start) > MAX_WAIT_MS) {
        navigator.geolocation.clearWatch(wid);
        best ? resolve(best) : reject(e);
      }
    };

    const wid = navigator.geolocation.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: MAX_WAIT_MS
    });
  });
}

// ---------- refresh (single nearest stop only) ----------
async function refresh(){
  const spin   = must('#spin');
  const status = must('#status');
  const err    = must('#err');
  const foot   = must('#foot');

  try{
    spin.style.display='inline-block';
    status.textContent = 'Updating…';
    err.textContent = '';

    if (!nearest) throw new Error('App not initialized yet (no nearest stop).');

    const stopIdStr = String(nearest.stop_id);

    // Query ONLY the single nearest stop id
    const { updates } = await getTrips([stopIdStr]);

    const now = nowSec();

    // Build candidates strictly for THIS stop_id (no siblings)
    const candidates = (updates || [])
      .filter(u => String(u.stopId) === stopIdStr)
      .map(u => {
        const epoch = (u.arrival ?? null) || (u.departure ?? null) || null;
        return epoch ? {
          routeId: u.routeId,
          stopId: u.stopId,
          eta: epoch - now
        } : null;
      })
      .filter(Boolean)
      .filter(x => x.eta > -30);

    const next = candidates.sort((a,b)=>a.eta - b.eta)[0] || null;

    renderNext(next);
    lastStamp = new Date();
    foot.textContent = `Last updated ${lastStamp.toLocaleTimeString()}`;

    // Debug info
    setDebug(
      `lat=${(user?.lat||nearest.lat).toFixed(5)}, lon=${(user?.lon||nearest.lon).toFixed(5)}, ` +
      `accuracy≈${Math.round(user?.accuracy||0)}m, stop=${nearest?.stop_id}, dist=${Math.round(nearest?.d||0)}m, skew=${Math.round(_clockSkewMs)}ms`
    );

    must('#btnRefresh').hidden = false;
  } catch(e){
    err.textContent = e.message;
  } finally {
    spin.style.display='none';
    status.textContent = 'Live';
  }
}

// ---------- boot helpers ----------
async function bootstrapWithCoords(lat, lon) {
  const status = must('#status');
  const where  = must('#where');
  const err    = must('#err');

  try {
    user = user || {};
    user.lat = lat;
    user.lon = lon;

    // sync time once per boot (fixes device clock differences)
    if (_clockSkewMs === 0) await syncServerTime();

    const [stops, routes] = await Promise.all([getStops(), getRoutes()]);
    buildRouteIndexes(routes);
    if (!stopsById[stops?.[0]?.stop_id ?? '']) buildStopIndex(stops);

    const pick = pickNearest(stops, user.lat, user.lon);
    nearest = pick.best;

    where.innerHTML = `
      <span>${nearest.name}</span>
      <span class="meta">(#${nearest.stop_id}) ·</span>
      <span class="dist">${fmtKm(nearest.d)} away</span>
    `;

    // If the "nearest" stop is far (>300 m), don't trust this fix; warn and let GPS refine
    if (nearest.d > BAD_NEAREST_M) {
      locationErrorHint('Your location looks too imprecise to choose the right stop.');
      setDebug(
        `lat=${user.lat.toFixed(5)}, lon=${user.lon.toFixed(5)}, accuracy≈${Math.round(user.accuracy||0)}m, ` +
        `nearestDist=${Math.round(nearest.d)}m (too far)`
      );
      return; // wait for a better position (init() keeps watching)
    } else {
      // clear any prior warning
      if (err.textContent.includes('imprecise') || err.textContent.includes('Precise Location')) err.textContent = '';
    }

    await refresh();
  } catch (e) {
    status.textContent = 'Startup error';
    err.textContent = e.message || String(e);
  }
}

// ---------- init (runs after DOM because of `defer`) ----------
async function init(){
  ['#status','#err','#spin','#where','#list','#foot','#btnRefresh'].forEach(must);

  const status = must('#status');

  if (!('geolocation' in navigator)) {
    status.textContent = 'No geolocation — using fallback location.';
    must('#err').textContent = 'Enable location (HTTPS required) for exact nearest stop.';
    // Minimal safe fallback (downtown). We deliberately DO NOT auto-show arrivals from a far stop.
    user = { lat: 43.645, lon: -79.380, accuracy: 9999 };
    setDebug('No geolocation; using fallback coords.');
    return;
  }

  // Actively hunt for a precise fix; update UI as the fix improves
  try {
    const pos = await getPrecisePosition();
    user = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
    await bootstrapWithCoords(user.lat, user.lon);

    // Keep refining for a short while in case first fix was coarse
    const refineStart = Date.now();
    const wid = navigator.geolocation.watchPosition(async p => {
      user = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy };
      await bootstrapWithCoords(user.lat, user.lon);
      // Stop refining if we’ve hit the accuracy goal or after a short window
      if (p.coords.accuracy <= ACCURACY_GOAL_M || (Date.now() - refineStart) > 20000) {
        navigator.geolocation.clearWatch(wid);
        // Start periodic prediction refresh (location fixed enough now)
        setInterval(refresh, 10000);
      }
    }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  } catch (e) {
    status.textContent = 'Location error';
    locationErrorHint(e.message);
  }

  must('#btnRefresh').addEventListener('click', refresh);
}

init(); // script is loaded with defer
