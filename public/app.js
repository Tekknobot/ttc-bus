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
let pin=null, nearest=null, siblings=[], allStops=[], lastStamp=null;
const routesById=Object.create(null), routesByShort=Object.create(null), stopsById=Object.create(null);
const LOCAL_KEY='ttcChosenStopId';
const SIBLING_RADIUS_M=120;
const SUSPICIOUS_M=300;

// ---------- index builders ----------
function buildRouteIndexes(routes){
  for(const r of routes||[]){
    if(r.route_id) routesById[String(r.route_id)]=r;
    if(r.short_name) routesByShort[String(r.short_name)]=r;
  }
}
function buildStopIndex(stops){
  for(const s of stops||[]) if(s.stop_id!=null) stopsById[String(s.stop_id)]=s;
}

// ---------- helpers ----------
function routeLabel(id){
  if(!id) return 'Route';
  const k=String(id); const r=routesById[k]||routesByShort[k];
  if(!r) return k;
  if(r.short_name&&r.long_name) return `${r.short_name} ${r.long_name}`;
  return r.short_name||r.long_name||k;
}
function pickNearest(stops,lat,lon){
  let best=null;
  for(const s of stops){
    const d=haversine(lat,lon,s.lat,s.lon);
    if(!best||d<best.d) best={...s,d};
  }
  const sibs=stops.filter(s=>haversine(best.lat,best.lon,s.lat,s.lon)<=SIBLING_RADIUS_M&&s.stop_id!==best.stop_id);
  return {best,sibs};
}

// ---------- UI ----------
function renderNext(list){
  const ul=must('#list'); ul.innerHTML='';
  const whereBar=must('#where');
  if(!document.getElementById('btnChangeStop')){
    const btn=`<button id="btnChangeStop" style="margin-left:8px;padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-weight:700;cursor:pointer">Change stop</button>`;
    whereBar.insertAdjacentHTML('beforeend',btn);
    $('#btnChangeStop').onclick=openChooser;
  }
  if(!list.length){
    ul.innerHTML=`<li class="empty">No live predictions right now for this stop.</li>`;
    return;
  }
  for(const it of list){
    const etaMin=Math.max(0,Math.round(it.eta/60));
    const cls=etaMin<=3?'eta good':(etaMin<=7?'eta warn':'eta');
    const label=routeLabel(it.routeId);
    const li=document.createElement('li');
    li.innerHTML=`
      <div class="row" style="display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:14px 16px">
        <div class="${cls}" style="font-size:22px;font-weight:800">${etaMin} min</div>
        <span class="pill" title="${label}" style="border:1px solid var(--border);padding:6px 10px;border-radius:999px;font-weight:700">${label}</span>
        <div class="sub" style="color:var(--muted);font-size:12px">Stop #${it.stopId}</div>
      </div>`;
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
  w.innerHTML=`<span>${nearest.name}</span>
    <span class="meta">(#${nearest.stop_id})</span>
    ${pin?`<span class="dist">${fmtKm(haversine(pin.lat,pin.lon,nearest.lat,nearest.lon))} from pin</span>`:''}`;
}

// ---------- refresh ----------
async function refresh(){
  const spin=must('#spin'),status=must('#status'),err=must('#err'),foot=must('#foot');
  try{
    spin.style.display='inline-block';status.textContent='Updating…';err.textContent='';
    if(!nearest) throw new Error('Pick a stop first.');
    const ids=[String(nearest.stop_id),...siblings.map(s=>String(s.stop_id))];
    const {updates}=await getTrips(ids);
    const now=nowSec();
    const list=(updates||[])
      .filter(u=>ids.includes(String(u.stopId)))
      .map(u=>{const t=(u.arrival??u.departure??null);return t?{routeId:u.routeId,stopId:u.stopId,eta:t-now}:null;})
      .filter(Boolean).filter(x=>x.eta>-30).sort((a,b)=>a.eta-b.eta).slice(0,10);
    renderNext(list);
    lastStamp=new Date();foot.textContent=`Last updated ${lastStamp.toLocaleTimeString()}`;
    must('#btnRefresh').hidden=false;
  }catch(e){err.textContent=e.message;}finally{spin.style.display='none';status.textContent='Live';}
}

// ---------- bootstrap ----------
async function bootstrap(){
  const status=must('#status'),err=must('#err');
  try{
    if(_clockSkewMs===0) await syncServerTime();
    const [stops,routes]=await Promise.all([getStops(),getRoutes()]);
    allStops=stops||[];buildRouteIndexes(routes);buildStopIndex(allStops);
    const saved=localStorage.getItem(LOCAL_KEY);
    if(saved&&stopsById[saved]){nearest=stopsById[saved];updateWhere();await refresh();setInterval(refresh,10000);return;}
    if('geolocation'in navigator){
      navigator.geolocation.getCurrentPosition(async pos=>{
        pin={lat:pos.coords.latitude,lon:pos.coords.longitude};
        const pick=pickNearest(allStops,pin.lat,pin.lon);
        nearest=pick.best;siblings=pick.sibs;
        updateWhere();
        const d=nearest.d;
        if(d>SUSPICIOUS_M){err.textContent='Location may be approximate — verify stop.';openChooser();}
        await refresh();setInterval(refresh,10000);
      },_=>{
        err.textContent='Location unavailable; search and pick your stop.';
        openChooser();setInterval(refresh,10000);
      },{enableHighAccuracy:true,timeout:10000,maximumAge:0});
    }else{
      err.textContent='No geolocation; search and pick your stop.';
      openChooser();setInterval(refresh,10000);
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
