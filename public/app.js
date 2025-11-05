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
  const A=Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(A),Math.sqrt(1-A));
};
const fmtKm = m => m < 1000 ? `${Math.round(m)} metres` : `${(m/1000).toFixed(2)} kilometres`;
const nowSec = () => Math.floor(Date.now()/1000);

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
async function getVehicles(){ return fetchJSON('/api/vehicles'); }

// ---------- state ----------
let nearest = null, siblings = [], lastStamp = null, user = null;

// Lookups
const routesById = Object.create(null);
const routesByShort = Object.create(null);
const stopsById = Object.create(null);

function buildRouteIndexes(routes) {
  for (const r of routes || []) {
    if (r.route_id) routesById[r.route_id] = r;
    if (r.short_name) routesByShort[r.short_name] = r;
  }
}
function buildStopIndex(stops) {
  for (const s of stops || []) {
    if (s.stop_id) stopsById[s.stop_id] = s;
  }
}

// Prefer "47 Lansdowne" if we can, else best available
function routeLabel(routeId) {
  if (!routeId) return 'Route';
  const r = routesById[routeId] || routesByShort[routeId];
  if (!r) return routeId;
  if (r.short_name && r.long_name) return `${r.short_name} ${r.long_name}`;
  return r.short_name || r.long_name || routeId;
}

// ---------- logic ----------
function pickNearest(stops, lat, lon){
  let best=null;
  for(const s of stops){
    const d = haversine(lat,lon,s.lat,s.lon);
    if(!best || d < best.d) best = {...s, d};
  }
  // tighter radius so we only catch opposite platform
  const sibs = stops.filter(s =>
    haversine(best.lat, best.lon, s.lat, s.lon) <= 80 &&
    s.stop_id !== best.stop_id
  );
  return { best, sibs };
}

function renderArrivals(list, fallbackNote=''){
  const ul = must('#list');
  ul.innerHTML = '';

  if (!list.length) {
    ul.innerHTML = `<li class="empty">No predictions right now. Try <strong>Refresh</strong>.</li>`;
  } else {
    for (const it of list) {
      const etaMin = it.eta === null ? null : Math.max(0, Math.round(it.eta / 60));
      const cls = etaMin === null ? 'eta' : (etaMin <= 3 ? 'eta good' : (etaMin <= 7 ? 'eta warn' : 'eta'));
      const label = routeLabel(it.routeId);

      const li = document.createElement('li');
      li.innerHTML = `
        <div class="row">
          <div class="${cls}">
            ${etaMin === null ? '—' : `${etaMin} min`}
          </div>
          <span class="pill" title="${label}">${label}</span>
        </div>
        <div class="sub">
          ${it.detail
            ? `Nearby vehicle — ${it.detail}`
            : `At stop #${it.stopId}`}
        </div>
      `;
      ul.appendChild(li);
    }
  }

  if (fallbackNote) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="sub">${fallbackNote}</div>`;
    ul.appendChild(li);
  }
}

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

    const ids = [nearest.stop_id, ...siblings.map(s=>s.stop_id)];
    const { updates } = await getTrips(ids);

    // Keep only updates whose stopId is geographically close to the nearest stop (or user)
    const now = nowSec();
    const baseLat = (user && user.lat) || nearest.lat;
    const baseLon = (user && user.lon) || nearest.lon;

    const MAX_STOP_DISTANCE_M = 180; // geo sanity window

    let list = (updates || [])
      .filter(u => {
        const stop = stopsById[u.stopId];
        if (!stop) return false;
        const d = haversine(baseLat, baseLon, stop.lat, stop.lon);
        return d <= MAX_STOP_DISTANCE_M;
      })
      .map(u => ({
        routeId: u.routeId,
        stopId: u.stopId,
        eta: (u.arrival || 0) - now
      }))
      .filter(x => x.eta > -60)
      .sort((a,b) => a.eta - b.eta)
      .slice(0,12);

    let note = '';

    // Fallback to nearby vehicles if no stop-matched predictions
    if (!list.length) {
      const v = await getVehicles();
      const near = [];
      for (const e of (v.entity||[])) {
        const veh = e.vehicle || e.vehiclePosition || e.vehicle_position;
        if (!veh || !veh.position) continue;
        const d = haversine(baseLat, baseLon, veh.position.latitude, veh.position.longitude);
        if (d <= 400) {
          const rid = veh.trip?.routeId || veh.trip?.route_id;
          near.push({
            routeId: rid || '—',
            stopId: veh.stopId || veh.stop_id || 'nearby',
            eta: null,
            detail: `${Math.round(d)} metres away`
          });
        }
      }
      if (near.length) {
        list = near.slice(0,8);
        note = 'Nearby vehicles within ~400 metres (fallback view).';
      }
    }

    renderArrivals(list, note);
    lastStamp = new Date();
    foot.textContent = `Last updated ${lastStamp.toLocaleTimeString()}`;
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
    const [stops, routes] = await Promise.all([getStops(), getRoutes()]);
    buildRouteIndexes(routes);
    buildStopIndex(stops);

    const pick = pickNearest(stops, user.lat, user.lon);
    nearest = pick.best; siblings = pick.sibs;

    where.innerHTML = `
      <span>${nearest.name}</span>
      <span class="meta">(#${nearest.stop_id}) ·</span>
      <span class="dist">${fmtKm(nearest.d)} away</span>
    `;

    await refresh();
    setInterval(refresh, 10000);
    status.textContent = 'Live';
  } catch (e) {
    status.textContent = 'Startup error';
    err.textContent = e.message || String(e);
  }
}

// ---------- init (runs after DOM because of `defer`) ----------
function init(){
  ['#status','#err','#spin','#where','#list','#foot','#btnRefresh'].forEach(must);

  const status = must('#status');

  // Geolocation fallback for non-HTTPS origins (still usable)
  if (!('geolocation' in navigator)) {
    status.textContent = 'No geolocation — using fallback location.';
    must('#err').textContent = 'Enable location (HTTPS required) for exact nearest stop.';
    // Downtown-ish fallback; change if you like
    bootstrapWithCoords(43.645, -79.380);
  } else {
    navigator.geolocation.getCurrentPosition(async pos=>{
      await bootstrapWithCoords(pos.coords.latitude, pos.coords.longitude);
    }, err=>{
      status.textContent = 'Location error';
      must('#err').textContent = err.message;
      // Still let the app run in a sensible place
      bootstrapWithCoords(43.645, -79.380);
    }, { enableHighAccuracy:true, timeout:10000 });
  }

  must('#btnRefresh').addEventListener('click', refresh);
}

init(); // script is loaded with defer
