// ---------- DOM helpers ----------
const $ = s => document.querySelector(s);
function must(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing DOM element: ${sel}`);
  return el;
}
function el(tag, attrs={}, html='') {
  const x = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) x.setAttribute(k, v);
  if (html) x.innerHTML = html;
  return x;
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
let pin = null;             // {lat, lon} from a single geo read or fallback
let nearest = null;         // chosen stop (can be user-selected)
let allStops = [];          // full stop list
let lastStamp = null;

// Lookups
const routesById = Object.create(null);
const routesByShort = Object.create(null);
const stopsById = Object.create(null);

const LOCAL_KEY = 'ttcChosenStopId';
const SUSPICIOUS_M = 300;          // if pin→stop distance > this, prompt chooser
const NEARBY_LIST_RADIUS_M = 2000; // show stops within 2km in chooser (fallback to top-N if none)

// ---------- build indexes ----------
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

function pickNearest(stops, lat, lon){
  let best=null;
  for(const s of stops){
    const d = haversine(lat,lon,s.lat,s.lon);
    if(!best || d < best.d) best = {...s, d};
  }
  return best;
}

// ---------- UI: render ----------
function renderNext(next){
  const ul = must('#list');
  ul.innerHTML = '';

  const whereBar = must('#where');
  const changeBtn = `<button id="btnChangeStop" style="margin-left:8px;padding:4px 8px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-weight:700;cursor:pointer">Not my stop?</button>`;
  // add change button only once
  if (!document.getElementById('btnChangeStop')) {
    whereBar.insertAdjacentHTML('beforeend', changeBtn);
    document.getElementById('btnChangeStop').addEventListener('click', openChooser);
  }

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

// ---------- chooser overlay ----------
function ensureChooserDOM(){
  if (document.getElementById('chooser')) return;
  const wrap = el('div', { id: 'chooser', style: `
    position: fixed; inset: 0; background: rgba(0,0,0,.45); display:none; z-index: 50;
  `});
  const sheet = el('div', { style: `
    position:absolute; left:50%; top:10%; transform:translateX(-50%);
    width:min(560px, 92vw); max-height: 80vh; overflow:auto;
    background: var(--card); border:1px solid var(--border); border-radius:16px; box-shadow: var(--shadow);
  `});
  sheet.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid var(--border)">
      <div style="font-weight:800">Choose your stop</div>
      <button id="chClose" style="padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-weight:700;cursor:pointer">Close</button>
    </div>
    <div style="padding:10px 14px; display:flex; gap:8px; align-items:center">
      <input id="chSearch" placeholder="Search by name or #id" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text)"/>
      <span id="chMeta" style="font-size:12px;color:var(--muted)"></span>
    </div>
    <ul id="chList" style="list-style:none;margin:0;padding:0"></ul>
  `;
  wrap.appendChild(sheet);
  document.body.appendChild(wrap);

  document.getElementById('chClose').onclick = closeChooser;
  document.getElementById('chSearch').oninput = () => populateChooser();
}
function openChooser(){
  ensureChooserDOM();
  populateChooser();
  const wrap = document.getElementById('chooser');
  wrap.style.display = 'block';
}
function closeChooser(){
  const wrap = document.getElementById('chooser');
  if (wrap) wrap.style.display = 'none';
}
function populateChooser(){
  const list = document.getElementById('chList');
  const meta = document.getElementById('chMeta');
  const q = (document.getElementById('chSearch').value || '').trim().toLowerCase();

  // compute distances from pin if we have it
  const withDist = allStops.map(s => ({
    ...s,
    d: pin ? haversine(pin.lat, pin.lon, s.lat, s.lon) : Infinity
  }));

  let items;
  if (q) {
    items = withDist.filter(s =>
      (s.name||'').toLowerCase().includes(q) ||
      String(s.stop_id).includes(q) ||
      String(s.stop_code||'').includes(q)
    ).sort((a,b)=>a.d - b.d).slice(0, 50);
  } else {
    // default: closest within radius, else just top-N closest
    const near = withDist.filter(s => s.d <= NEARBY_LIST_RADIUS_M).sort((a,b)=>a.d - b.d);
    items = (near.length ? near : withDist.sort((a,b)=>a.d - b.d)).slice(0, 50);
  }

  meta.textContent = pin ? `from pin • ${items.length} shown` : `${items.length} shown`;

  list.innerHTML = '';
  for (const s of items) {
    const li = el('li', { style: 'border-top:1px solid var(--border)' }, `
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:12px 14px">
        <div>
          <div style="font-weight:800">${s.name}</div>
          <div style="color:var(--muted);font-size:12px">#${s.stop_id}${s.stop_code?` · code ${s.stop_code}`:''}</div>
        </div>
        <div style="font-size:12px;color:var(--muted)">${Number.isFinite(s.d) ? fmtKm(s.d) : ''}</div>
      </div>
    `);
    li.style.cursor = 'pointer';
    li.onclick = async () => {
      nearest = s;
      localStorage.setItem(LOCAL_KEY, String(s.stop_id));
      updateWhereBar();
      closeChooser();
      await refresh();
    };
    list.appendChild(li);
  }
}

// ---------- UI helpers ----------
function updateWhereBar(){
  const where = must('#where');
  where.innerHTML = `
    <span>${nearest.name}</span>
    <span class="meta">(#${nearest.stop_id}) ·</span>
    ${
      pin
        ? `<span class="dist">${fmtKm(haversine(pin.lat, pin.lon, nearest.lat, nearest.lon))} from pin</span>`
        : ''
    }
  `;
}

// ---------- refresh (query only the chosen stop) ----------
async function refresh(){
  const spin   = must('#spin');
  const status = must('#status');
  const err    = must('#err');
  const foot   = must('#foot');

  try{
    spin.style.display='inline-block';
    status.textContent = 'Updating…';
    err.textContent = '';

    if (!nearest) throw new Error('Pick a stop to see arrivals.');

    const stopIdStr = String(nearest.stop_id);
    const { updates } = await getTrips([stopIdStr]);

    const now = nowSec();
    const candidates = (updates || [])
      .filter(u => String(u.stopId) === stopIdStr)
      .map(u => {
        const epoch = (u.arrival ?? null) || (u.departure ?? null) || null;
        return epoch ? { routeId: u.routeId, stopId: u.stopId, eta: epoch - now } : null;
      })
      .filter(Boolean)
      .filter(x => x.eta > -30);

    const next = candidates.sort((a,b)=>a.eta - b.eta)[0] || null;

    renderNext(next);
    lastStamp = new Date();
    foot.textContent = `Last updated ${lastStamp.toLocaleTimeString()}`;

    // If we have no prediction often, offer stop chooser quickly
    if (!next && !document.getElementById('btnChangeStop')) {
      const whereBar = must('#where');
      const changeBtn = `<button id="btnChangeStop" style="margin-left:8px;padding:4px 8px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-weight:700;cursor:pointer">Choose nearby stop</button>`;
      whereBar.insertAdjacentHTML('beforeend', changeBtn);
      document.getElementById('btnChangeStop').addEventListener('click', openChooser);
    }

    must('#btnRefresh').hidden = false;
  } catch(e){
    err.textContent = e.message;
  } finally {
    spin.style.display='none';
    status.textContent = 'Live';
  }
}

// ---------- boot (geolocate once for the pin, then let user confirm/override) ----------
async function bootstrap(){
  const status = must('#status');
  const err    = must('#err');

  try {
    if (_clockSkewMs === 0) await syncServerTime();

    const [stops, routes] = await Promise.all([getStops(), getRoutes()]);
    allStops = stops || [];
    buildRouteIndexes(routes);
    buildStopIndex(allStops);

    // 1) If user has a saved stop, use it immediately
    const saved = localStorage.getItem(LOCAL_KEY);
    if (saved && stopsById[saved]) {
      nearest = stopsById[saved];
      updateWhereBar();
      await refresh();
      setInterval(refresh, 10000);
      return;
    }

    // 2) Otherwise, try one-shot geolocation JUST to place the pin
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(async pos=>{
        pin = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        nearest = pickNearest(allStops, pin.lat, pin.lon);
        updateWhereBar();

        // If this looks suspicious (>300 m), prompt the chooser
        const d = haversine(pin.lat, pin.lon, nearest.lat, nearest.lon);
        if (d > SUSPICIOUS_M) {
          err.textContent = 'Your first location fix looked approximate. Pick your stop below.';
          openChooser();
        }

        await refresh();
        setInterval(refresh, 10000);
      }, async _err=>{
        // 3) Fallback pin (no geolocation)
        err.textContent = 'Location unavailable; search and pick your stop.';
        pin = null;
        openChooser();
        // still start a refresh loop; it will say "Pick a stop" until the user chooses
        setInterval(refresh, 10000);
      }, { enableHighAccuracy:true, timeout:10000, maximumAge:0 });
    } else {
      err.textContent = 'No geolocation; search and pick your stop.';
      pin = null;
      openChooser();
      setInterval(refresh, 10000);
    }
  } catch (e) {
    status.textContent = 'Startup error';
    err.textContent = e.message || String(e);
  }
}

// ---------- init ----------
function init(){
  ['#status','#err','#spin','#where','#list','#foot','#btnRefresh'].forEach(must);
  ensureChooserDOM();
  must('#btnRefresh').addEventListener('click', refresh);
  bootstrap();
}

init();
