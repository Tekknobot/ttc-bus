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
async function getTrips(stopIds){
  const qs = encodeURIComponent(stopIds.join(','));
  return fetchJSON('/api/trip-updates?stop='+qs);
}
async function getVehicles(){ return fetchJSON('/api/vehicles'); }

// ---------- state ----------
let nearest = null, siblings = [], lastStamp = null, user = null;

// ---------- logic ----------
function pickNearest(stops, lat, lon){
  let best=null;
  for(const s of stops){
    const d = haversine(lat,lon,s.lat,s.lon);
    if(!best || d < best.d) best = {...s, d};
  }
  const sibs = stops.filter(s =>
    haversine(best.lat, best.lon, s.lat, s.lon) <= 120 &&
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

      const li = document.createElement('li');
      li.innerHTML = `
        <div class="row">
          <div class="${cls}">
            ${etaMin === null ? '—' : `${etaMin} min`}
          </div>
          <span class="pill" title="Route number">Route ${it.routeId || '—'}</span>
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

    const ids = [nearest.stop_id, ...siblings.map(s=>s.stop_id)];
    const { updates } = await getTrips(ids);

    const now = nowSec();
    let list = (updates||[])
      .map(u => ({ routeId: u.routeId, stopId: u.stopId, eta: (u.arrival||0) - now }))
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
        const d = haversine(user.lat, user.lon, veh.position.latitude, veh.position.longitude);
        if (d <= 400) {
          near.push({
            routeId: veh.trip?.routeId || veh.trip?.route_id || 'Bus',
            stopId: veh.stopId || veh.stop_id || 'nearby',
            eta: null,
            detail: `${Math.round(d)} m away`
          });
        }
      }
      if (near.length) {
        list = near.slice(0,8);
        note = 'Nearby vehicles within ~400 m (fallback view).';
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

// ---------- init (runs after DOM because of `defer`) ----------
function init(){
  // Ensure required elements exist; throws early if markup is missing
  ['#status','#err','#spin','#where','#list','#foot','#btnRefresh'].forEach(must);

  const status = must('#status');
  const where  = must('#where');

  if (!('geolocation' in navigator)) {
    status.textContent = 'Geolocation not supported.';
    return;
  }

  navigator.geolocation.getCurrentPosition(async pos=>{
    user = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    const stops = await getStops();
    const pick = pickNearest(stops, user.lat, user.lon);
    nearest = pick.best; siblings = pick.sibs;

    // BIG, padded location line content
    where.innerHTML = `
      <span>${nearest.name}</span>
      <span class="meta">(#${nearest.stop_id}) ·</span>
      <span class="dist">${fmtKm(nearest.d)} away</span>
    `;

    await refresh();
    setInterval(refresh, 10000);
  }, err=>{
    status.textContent = 'Location error';
    must('#err').textContent = err.message;
  }, { enableHighAccuracy:true, timeout:10000 });

  must('#btnRefresh').addEventListener('click', refresh);
}

// Because the script is loaded with `defer`, DOM is ready here:
init();
