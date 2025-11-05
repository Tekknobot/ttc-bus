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
const nowSec = () => Math.floor(Date.now()/1000);

// ETA estimator for fallback (distance in m, speed in m/s)
function estimateEtaSeconds(distanceM, speedMpsNullable) {
  // clamp speed to realistic street ops; default ≈ 18 km/h
  const v = Number.isFinite(speedMpsNullable) && speedMpsNullable > 0
    ? Math.max(2.0, Math.min(10.0, speedMpsNullable)) // 7.2–36 km/h
    : 5.0; // default 18 km/h
  // travel time + small buffer for lights/dwell
  const ETA = (distanceM / v) + 30;           // +30s buffer
  const ETA_CLAMP = Math.max(30, Math.min(1200, ETA)); // 0.5–20 min
  return Math.round(ETA_CLAMP);
}

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
let nearest = null, lastStamp = null, user = null;

// Lookups
const routesById = Object.create(null);
const routesByShort = Object.create(null);
const stopsById = Object.create(null);

function buildRouteIndexes(routes) {
  for (const r of routes || []) {
    if (r.route_id) routesById[String(r.route_id)] = r;
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

function renderArrivals(list, fallbackNote=''){
  const ul = must('#list');
  ul.innerHTML = '';

  if (!list.length) {
    ul.innerHTML = `<li class="empty">No predictions right now. Try <strong>Refresh</strong>.</li>`;
  } else {
    for (const it of list) {
      const etaMin = it.eta === null ? null : Math.max(0, Math.round(it.eta / 60));
      const estMark = it.isEstimate ? '≈ ' : '';
      const cls = etaMin === null ? 'eta' : (etaMin <= 3 ? 'eta good' : (etaMin <= 7 ? 'eta warn' : 'eta'));
      const label = routeLabel(it.routeId);

      const li = document.createElement('li');
      li.innerHTML = `
        <div class="row">
          <div class="${cls}">
            ${etaMin === null ? '—' : `${estMark}${etaMin} min`}
          </div>
          <span class="pill" title="${label}">${label}</span>
        </div>
        <div class="sub">
          ${it.detail
            ? `${it.detail}${it.isEstimate ? ' (est.)' : ''}`
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

    // Query ONLY the single nearest stop id
    const ids = [String(nearest.stop_id)];
    const { updates } = await getTrips(ids);

    // Keep only updates whose stopId is close to this stop
    const now = nowSec();
    const baseLat = (user && user.lat) || nearest.lat;
    const baseLon = (user && user.lon) || nearest.lon;

    const MAX_STOP_DISTANCE_M = 60; // tight geo sanity window

    let list = (updates || [])
      .filter(u => {
        const stop = stopsById[String(u.stopId)];
        if (!stop) return false;
        const d = haversine(baseLat, baseLon, stop.lat, stop.lon);
        return d <= MAX_STOP_DISTANCE_M;
      })
      .map(u => ({
        routeId: u.routeId,
        stopId: u.stopId,
        eta: (u.arrival || 0) - now,
        isEstimate: false
      }))
      .filter(x => x.eta > -60)
      .sort((a,b) => a.eta - b.eta)
      .slice(0,12);

    let note = '';

    // Fallback: estimate ETAs from nearby vehicles
    if (!list.length) {
      const v = await getVehicles();
      const near = [];
      for (const e of (v.entity||[])) {
        const veh = e.vehicle || e.vehiclePosition || e.vehicle_position;
        if (!veh || !veh.position) continue;
        const d = haversine(baseLat, baseLon, veh.position.latitude, veh.position.longitude);
        if (d <= 400) {
          const rid = veh.trip?.routeId || veh.trip?.route_id;
          const spd = veh.position.speed; // m/s (optional)
          const etaSec = estimateEtaSeconds(d, spd);
          near.push({
            routeId: rid || '—',
            stopId: veh.stopId || veh.stop_id || 'nearby',
            eta: etaSec,
            isEstimate: true,
            detail: `${Math.round(d)} metres away`
          });
        }
      }
      if (near.length) {
        // soonest first
        list = near.sort((a,b)=>a.eta-b.eta).slice(0,8);
        note = 'Nearby vehicles within ~400 metres (estimated ETAs).';
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
    nearest = pick.best;

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

  if (!('geolocation' in navigator)) {
    status.textContent = 'No geolocation — using fallback location.';
    must('#err').textContent = 'Enable location (HTTPS required) for exact nearest stop.';
    bootstrapWithCoords(43.645, -79.380);
  } else {
    navigator.geolocation.getCurrentPosition(async pos=>{
      await bootstrapWithCoords(pos.coords.latitude, pos.coords.longitude);
    }, err=>{
      status.textContent = 'Location error';
      must('#err').textContent = err.message;
      bootstrapWithCoords(43.645, -79.380);
    }, { enableHighAccuracy:true, timeout:10000 });
  }

  must('#btnRefresh').addEventListener('click', refresh);
}

init(); // script is loaded with defer
