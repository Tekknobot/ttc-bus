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
let pin = null;        // {lat, lon} from ONE geolocation read (or fallback)
let nearest = null;    // chosen stop closest to the pin
let lastStamp = null;

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
  return best;
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

// ---------- refresh (query only the chosen stop near the pin) ----------
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
    const { updates } = await getTrips([stopIdStr]);

    const now = nowSec();
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
    must('#btnRefresh').hidden = false;
  } catch(e){
    err.textContent = e.message;
  } finally {
    spin.style.display='none';
    status.textContent = 'Live';
  }
}

// ---------- boot (use geolocation ONCE to set the pin, then stick to that stop) ----------
async function bootstrapWithPin(lat, lon) {
  const status = must('#status');
  const where  = must('#where');
  const err    = must('#err');

  try {
    pin = { lat, lon };

    if (_clockSkewMs === 0) await syncServerTime();

    const [stops, routes] = await Promise.all([getStops(), getRoutes()]);
    buildRouteIndexes(routes);
    if (!stopsById[stops?.[0]?.stop_id ?? '']) buildStopIndex(stops);

    nearest = pickNearest(stops, pin.lat, pin.lon);

    where.innerHTML = `
      <span>${nearest.name}</span>
      <span class="meta">(#${nearest.stop_id}) ·</span>
      <span class="dist">${fmtKm(nearest.d)} away</span>
    `;

    await refresh();
  } catch (e) {
    status.textContent = 'Startup error';
    err.textContent = e.message || String(e);
  }
}

// ---------- init ----------
function init(){
  ['#status','#err','#spin','#where','#list','#foot','#btnRefresh'].forEach(must);

  const status = must('#status');

  // Geolocation ONLY to place the pin once; afterwards we never use device location again
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(async pos=>{
      await bootstrapWithPin(pos.coords.latitude, pos.coords.longitude);
      // prediction refresh only; location is fixed to the pin's nearest stop
      setInterval(refresh, 10000);
    }, async _err=>{
      status.textContent = 'Using fallback pin';
      must('#err').textContent = 'Location unavailable; using a central fallback. Allow location for a more accurate pin.';
      // Downtown fallback pin
      await bootstrapWithPin(43.645, -79.380);
      setInterval(refresh, 10000);
    }, { enableHighAccuracy:true, timeout:10000, maximumAge:0 });
  } else {
    status.textContent = 'No geolocation — using fallback pin.';
    must('#err').textContent = 'Enable location (HTTPS required) to place the pin near you.';
    bootstrapWithPin(43.645, -79.380);
    setInterval(refresh, 10000);
  }

  must('#btnRefresh').addEventListener('click', refresh);
}

init(); // script is loaded with defer
