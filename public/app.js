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
const fmtKm = m => m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(2)} km`;

// ---------- time (server skew) ----------
let _clockSkewMs = 0;
async function syncServerTime(){
  try {
    const r = await fetch('/api/health',{cache:'no-store'});
    const {ts} = await r.json();
    _clockSkewMs = Number(ts) - Date.now();
  } catch {}
}
const nowSec = () => Math.floor((Date.now()+_clockSkewMs)/1000);

// ---------- fetch helpers ----------
async function fetchJSON(url){
  const r = await fetch(url,{cache:'no-store'});
  const t = await r.text();
  try{
    const j = JSON.parse(t);
    if(!r.ok) throw new Error(j.error||r.statusText);
    return j;
  }catch(e){ throw new Error(`HTTP ${r.status}: ${t.slice(0,200)}`);}
}

// ---------- API wrappers ----------
const getStops  =()=>fetchJSON('/api/stops');
const getRoutes =()=>fetchJSON('/api/routes');
const getTrips  =ids=>fetchJSON('/api/trip-updates?stop='+encodeURIComponent(ids.join(',')));

// ---------- state ----------
let pin=null, nearest=null, allStops=[], lastStamp=null;
const routesById=Object.create(null), stopsById=Object.create(null);
const LOCAL_KEY='ttcChosenStopId';
const SUSPICIOUS_M=300; // prompt chooser if pin->stop is farther than this

// Route filtering state
let selectedRouteShort = null; // e.g. "52"
const ROUTE_KEY='ttcChosenRouteShort';

// ---------- index builders ----------
function buildRouteIndexes(routes){
  for(const r of routes||[]){
    if(r.route_id != null) routesById[String(r.route_id)]=r;
  }
}
function buildStopIndex(stops){
  for(const s of stops||[]) if(s.stop_id!=null) stopsById[String(s.stop_id)]=s;
}

// ---------- helpers ----------
function routeLabel(routeId){
  // IMPORTANT: only resolve by route_id to avoid mislabeling as some other line's short_name.
  const r = routeId != null ? routesById[String(routeId)] : null;
  if(!r) return String(routeId ?? 'Route');
  if(r.short_name && r.long_name) return `${r.short_name} ${r.long_name}`;
  return r.short_name || r.long_name || String(routeId);
}

function pickNearest(stops,lat,lon){
  let best=null;
  for(const s of stops){
    const d=haversine(lat,lon,s.lat,s.lon);
    if(!best||d<best.d) best={...s,d};
  }
  return best;
}

function allowedRouteIdsForShortName(short) {
  if (!short) return null;
  const want = String(short).trim();
  if (!want) return null;
  const s = new Set();
  for (const r of Object.values(routesById)) {
    if (String(r?.short_name) === want && r?.route_id != null) s.add(String(r.route_id));
  }
  return s.size ? s : null;
}

function setRouteFilter(short) {
  selectedRouteShort = short && String(short).trim() ? String(short).trim() : null;
  if (selectedRouteShort) {
    localStorage.setItem(ROUTE_KEY, selectedRouteShort);
  } else {
    localStorage.removeItem(ROUTE_KEY);
  }
  updateWhere();
  refresh();
}

// ---------- UI ----------
function renderNext(list){
  const ul=must('#list'); ul.innerHTML='';
  const whereBar=must('#where');

  // Buttons (only once)
  if(!document.getElementById('btnChangeStop')){
    const btns=`
      <button id="btnChangeStop" style="margin-left:8px;padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-weight:700;cursor:pointer">Change stop</button>
      <button id="btnRouteFilter" style="margin-left:8px;padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-weight:700;cursor:pointer">Filter route</button>
      <button id="btnClearRoute" style="margin-left:8px;padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-weight:700;cursor:pointer">Clear</button>
    `;
    whereBar.insertAdjacentHTML('beforeend',btns);
    $('#btnChangeStop').onclick=openChooser;
    $('#btnRouteFilter').onclick=async()=>{
      const v=prompt('Enter route number (short name), e.g. 32');
      if(v==null) return; // cancel
      const trimmed=String(v).trim();
      if(!trimmed){ setRouteFilter(null); return; }
      const allowed=allowedRouteIdsForShortName(trimmed);
      if(!allowed){
        alert(`No routes with short_name "${trimmed}" found.`);
        return;
      }
      setRouteFilter(trimmed);
    };
    $('#btnClearRoute').onclick=()=>setRouteFilter(null);
  }

  if(!list.length){
    ul.innerHTML=`<li class="empty">No live predictions right now for this stop${selectedRouteShort?` on route ${selectedRouteShort}`:''}.</li>`;
    return;
  }
  for(const it of list){
    const etaMin=Math.max(0,Math.round(it.eta/60));
    const cls=etaMin<=3?'eta good':(etaMin<=7?'eta warn':'eta');
    const label=routeLabel(it.routeId);
    const li=document.createElement('li');
    li.innerHTML = `
      <div class="row" style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px">
        <div class="${cls}" style="font-size:22px;font-weight:800">${etaMin} min</div>
        <span class="pill" title="${label}" style="border:1px solid var(--border);padding:6px 10px;border-radius:999px;font-weight:700">${label}</span>
      </div>
      <div class="sub" style="color:var(--muted);font-size:12px;padding:0 16px 8px">Stop #${it.stopId}</div>
    `;
    ul.appendChild(li);
  }
}

// ---------- chooser ----------
function ensureChooser(){
  if($('#chooser')) return;
  const wrap=el('div',{id:'chooser',style:`position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:50`});
  const sheet=el('div',{style:`position:absolute;left:50%;top:10%;transform:translateX(-50%);width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow)`});
  sheet.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)">
      <strong>Choose your stop</strong>
      <button id="chClose" style="padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer">Close</button>
    </div>
    <div style="padding:10px 16px;display:flex;gap:8px;align-items:center">
      <input id="chSearch" placeholder="Search name or #id" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text)"/>
    </div>
    <ul id="chList" style="list-style:none;margin:0;padding:0"></ul>`;
  wrap.appendChild(sheet); document.body.appendChild(wrap);
  $('#chClose').onclick=()=>wrap.style.display='none';
  $('#chSearch').oninput=populateChooser;
}
function openChooser(){ensureChooser();populateChooser();$('#chooser').style.display='block';}
function populateChooser(){
  const list=$('#chList'); const q=($('#chSearch').value||'').toLowerCase();
  const arr=allStops.map(s=>({...s,d:pin?haversine(pin.lat,pin.lon,s.lat,s.lon):Infinity}));
  let items=q?arr.filter(s=>(s.name||'').toLowerCase().includes(q)||String(s.stop_id).includes(q)).sort((a,b)=>a.d-b.d).slice(0,50):arr.sort((a,b)=>a.d-b.d).slice(0,50);
  list.innerHTML='';
  for(const s of items){
    const li=el('li',{style:'border-top:1px solid var(--border);padding:12px 16px;cursor:pointer'},`
      <div style="font-weight:700">${s.name}</div>
      <div style="font-size:12px;color:var(--muted)">#${s.stop_id} · ${fmtKm(s.d)}</div>`);
    li.onclick=async()=>{nearest=s;localStorage.setItem(LOCAL_KEY,String(s.stop_id));updateWhere();$('#chooser').style.display='none';await refresh();};
    list.appendChild(li);
  }
}

// ---------- helpers ----------
function updateWhere(){
  const w=must('#where');
  const dist = pin?`<span class="dist">${fmtKm(haversine(pin.lat,pin.lon,nearest.lat,nearest.lon))} from pin</span>`:'';
  const routeChip = selectedRouteShort
    ? `<span class="pill" style="margin-left:8px;border:1px solid var(--border);padding:4px 8px;border-radius:999px;font-weight:700">Route ${selectedRouteShort}</span>`
    : '';
  w.innerHTML=`<span>${nearest.name}</span>
    <span class="meta">(#${nearest.stop_id})</span>
    ${routeChip}
    ${dist}`;
}

// ---------- refresh ----------
async function refresh() {
  const spin  = must('#spin'),
        status= must('#status'),
        err   = must('#err'),
        foot  = must('#foot');

  const pick = (obj, ...keys) => keys.reduce((v,k)=>v ?? obj?.[k], undefined);

  try {
    spin.style.display = 'inline-block';
    status.textContent = 'Updating…';
    err.textContent = '';

    if (!nearest) throw new Error('Pick a stop first.');

    const stopIdStr = String(nearest.stop_id ?? nearest.stopId ?? nearest.id);
    const tripsResp = await getTrips([stopIdStr]);
    const updates   = tripsResp?.updates ?? [];

    // Optional vehicle feed (used only to reject clearly wrong routes)
    let entity = [];
    try {
      const v = await fetchJSON('/api/vehicles');
      entity = Array.isArray(v?.entity) ? v.entity : [];
    } catch { /* ignore if vehicle feed down */ }

    const now = nowSec();

    // If a route number (short_name) is chosen, precompute allowed route_ids
    const allowedRouteIds =
      selectedRouteShort ? allowedRouteIdsForShortName(selectedRouteShort) : null;

    const list = updates
      // accept various possible key names for stop id
      .filter(u => {
        const sid = pick(u, 'stopId', 'stop_id', 'stop');
        return String(sid) === stopIdStr;
      })
      .map(u => {
        // normalize time (arrival/departure) and units
        let t = pick(u, 'arrival', 'arrival_time', 'departure', 'departure_time');
        if (t == null) return null;
        if (typeof t !== 'number') t = Number(t);
        if (!Number.isFinite(t)) return null;
        if (t > 1e12) t = Math.floor(t / 1000); // ms → s

        // normalize route/trip ids for vehicle cross-check
        const rid = pick(u, 'routeId', 'route_id', 'route');
        const tid = pick(u, 'tripId', 'trip_id', 'trip');
        const sid = pick(u, 'stopId', 'stop_id', 'stop');

        // Apply route-number (short_name) filter by mapping to route_ids
        if (allowedRouteIds && !allowedRouteIds.has(String(rid))) return null;

        // try to match a vehicle, but don't require one
        const veh = entity.find(e => {
          const trip  = e?.vehicle?.trip || {};
          const vrid  = pick(trip, 'routeId', 'route_id');
          const vtid  = pick(trip, 'tripId', 'trip_id');
          return (vrid != null && String(vrid) === String(rid)) || (vtid != null && vtid === tid);
        });

        let good = true;
        const pos = veh?.vehicle?.position;
        if (pos && Number.isFinite(pos.latitude) && Number.isFinite(pos.longitude)) {
          const d = haversine(nearest.lat, nearest.lon, pos.latitude, pos.longitude);
          // only reject if the bus is clearly nowhere near the stop
          if (d > 2000) good = false;
        }

        return good ? { routeId: rid, stopId: sid, eta: t - now } : null;
      })
      .filter(Boolean)
      .filter(x => x.eta > -30)           // keep slightly late vehicles
      .sort((a, b) => a.eta - b.eta)
      .slice(0, 10);

    renderNext(list);
    lastStamp = new Date();
    foot.textContent = `Last updated ${lastStamp.toLocaleTimeString()}`;
    must('#btnRefresh').hidden = false;
  } catch (e) {
    err.textContent = e?.message || String(e);
  } finally {
    spin.style.display = 'none';
    status.textContent = 'Live';
  }
}

// ---------- bootstrap ----------
async function bootstrap(){
  const status=must('#status'),err=must('#err');
  try{
    if(_clockSkewMs===0) await syncServerTime();
    const [stops,routes]=await Promise.all([getStops(),getRoutes()]);
    allStops=stops||[];buildRouteIndexes(routes);buildStopIndex(allStops);

    // restore route filter
    const savedRouteShort = localStorage.getItem(ROUTE_KEY);
    if (savedRouteShort) selectedRouteShort = savedRouteShort;

    const saved=localStorage.getItem(LOCAL_KEY);
    if(saved&&stopsById[saved]){
      nearest=stopsById[saved]; updateWhere(); await refresh(); setInterval(refresh,10000); return;
    }

    if('geolocation'in navigator){
      navigator.geolocation.getCurrentPosition(async pos=>{
        pin={lat:pos.coords.latitude,lon:pos.coords.longitude};
        nearest=pickNearest(allStops,pin.lat,pin.lon);
        updateWhere();
        const d=nearest.d;
        if(d>SUSPICIOUS_M){ err.textContent='Location may be approximate — verify stop.'; openChooser(); }
        await refresh(); setInterval(refresh,10000);
      }, _=>{
        err.textContent='Location unavailable; search and pick your stop.';
        openChooser(); setInterval(refresh,10000);
      }, {enableHighAccuracy:true,timeout:10000,maximumAge:0});
    }else{
      err.textContent='No geolocation; search and pick your stop.';
      openChooser(); setInterval(refresh,10000);
    }
  }catch(e){status.textContent='Startup error';err.textContent=e.message||String(e);}
}

// ---------- init ----------
function init(){
  ['#status','#err','#spin','#where','#list','#foot','#btnRefresh'].forEach(must);
  ensureChooser();
  must('#btnRefresh').addEventListener('click',refresh);
  bootstrap();
}
init();
