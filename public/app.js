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
function maybeWarnImprecise() {
  if (nearest && nearest.d > 150) {
    const txt = 'Location looks approximate. On iPhone: enable Precise Location for this site.';
    const err = must('#err');
    if (!err.textContent.includes('Precise Location')) err.textContent = txt;
  }
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

    // Build candidates strictly for THIS stop_id (no geo math, no siblings)
    const candidates = (updates || [])
      .filter(u => String(u.stopId) === stopIdStr)
      .map(u => {
        // Prefer arrival, fall back to departure if ever present in upstream
        const epoch = (u.arrival ?? null) || (u.departure ?? null) || null;
        return epoch ? {
          routeId: u.routeId,
          stopId: u.stopId,
          eta: epoch - now
        } : null;
      })
      .filter(Boolean)
      // drop stale/negative by more than a tiny grace
      .filter(x => x.eta > -30);

    // Pick soonest
    const next = candidates.sort((a,b)=>a.eta - b.eta)[0] || null;

    renderNext(next);
    lastStamp = new Date();
    foot.textContent = `Last updated ${lastStamp.toLocaleTimeString()}`;

    // Debug info
    setDebug(
      `lat=${(user?.lat||nearest.lat).toFixed(5)}, lon=${(user?.lon||nearest.lon).toFixed(5)}, ` +
      `stop=${nearest?.stop_id}, dist=${Math.round(nearest?.d||0)}m, skew=${Math.round(_clockSkewMs)}ms`
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
    user = { lat, lon };

    // sync time once per boot (fixes device clock differences)
    await syncServerTime();

    const [stops, routes] = await Promise.all([getStops(), getRoutes()]);
    buildRouteIndexes(routes);
    buildStopIndex(stops);

    const pick = pickNearest(stops, user.lat, user.lon);
    nearest = pick.best;

    where.innerHTML = `
      <span>${nearest.name}</span>
      <span class="meta">(#${nearest.stop_id}) ·</span>
      <span class="dist">${fmtKm(nearest.d)} away</span>
    `;

    maybeWarnImprecise();
    await refresh();
  } catch (e) {
    status.textContent = 'Startup error';
    err.textContent = e.message || String(e);
  }
}

// ---------- init (runs after DOM because of `defer`) ----------
function init(){
  ['#status','#err','#spin','#where','#list','#foot','#btnRefresh'].forEach(must);

  const status = must('#status');
  const useWatch = new URLSearchParams(location.search).get('live') === '1';

  const geoOpts = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };

  if (!('geolocation' in navigator)) {
    status.textContent = 'No geolocation — using fallback location.';
    must('#err').textContent = 'Enable location (HTTPS required) for exact nearest stop.';
    // Downtown-ish fallback; change if you like
    bootstrapWithCoords(43.645, -79.380);
  } else {
    // initial fix
    navigator.geolocation.getCurrentPosition(async pos=>{
      await bootstrapWithCoords(pos.coords.latitude, pos.coords.longitude);
      // optional continuous updates for moving users
      if (useWatch) {
        navigator.geolocation.watchPosition(p => {
          bootstrapWithCoords(p.coords.latitude, p.coords.longitude);
        }, () => {}, geoOpts);
      } else {
        // periodic refresh of predictions only (location fixed)
        setInterval(refresh, 10000);
      }
    }, err=>{
      status.textContent = 'Location error';
      must('#err').textContent = err.message;
      bootstrapWithCoords(43.645, -79.380);
      setInterval(refresh, 10000);
    }, geoOpts);
  }

  must('#btnRefresh').addEventListener('click', refresh);
}

init(); // script is loaded with defer
