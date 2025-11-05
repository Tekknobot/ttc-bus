const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');
const protobuf = require('protobufjs');

// Polyfill fetch for Node < 18
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

const app = express();
const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PROTO_PATH = path.join(ROOT, 'gtfs-realtime.proto');

// Writable data dir (serverless friendly)
const DATA_DIR = process.env.DATA_DIR || os.tmpdir();
const STOPS_PATH  = path.join(DATA_DIR, 'stops.json');
const ROUTES_PATH = path.join(DATA_DIR, 'routes.json');
const TMP_GTFS_ZIP = path.join(DATA_DIR, 'ttc_gtfs.zip');

const GTFS_ZIP_URL =
  'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/TTC%20Routes%20and%20Schedules%20Data.zip';

let FeedMessage = null;
async function loadProto() {
  if (FeedMessage) return FeedMessage;
  if (!fs.existsSync(PROTO_PATH)) {
    throw new Error(`Missing ${PROTO_PATH}. Place GTFS-RT proto next to server.js.`);
  }
  const root = await protobuf.load(PROTO_PATH);
  FeedMessage = root.lookupType('transit_realtime.FeedMessage');
  return FeedMessage;
}

// Tiny memory cache for upstream
const cache = new Map();
const getCache = (k)=>{ const v = cache.get(k); if(!v) return null; if(Date.now()>v.exp){cache.delete(k);return null;} return v.data; };
const putCache = (k,d,ttl=10000)=>cache.set(k,{data:d,exp:Date.now()+ttl});

let stopsMem = null;   // [{ stop_id, stop_code, name, lat, lon }]
let routesMem = null;  // [{ route_id, short_name, long_name }]

// helpers
async function fetchBufferOrDie(url) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'Accept': 'application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1',
      'User-Agent': 'ttc-arrivals/1.0 (+ops@yourdomain)'
    }
  });
  if (!r.ok) {
    const text = await r.text().catch(()=>`<no body>`);
    const err = new Error(`Upstream ${r.status} ${r.statusText}`);
    err.details = text.slice(0, 400);
    err.status = r.status;
    throw err;
  }
  return Buffer.from(await r.arrayBuffer());
}

// Basic CSV (handles quotes)
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    const row = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i+1] === '"') { cur += '"'; i++; continue; }
        inQ = !inQ; continue;
      }
      if (ch === ',' && !inQ) { row.push(cur); cur=''; } else { cur += ch; }
    }
    row.push(cur);
    out.push(row);
  }
  return out;
}

async function ensureGtfsZip() {
  if (fs.existsSync(TMP_GTFS_ZIP)) return;
  const buf = await fetchBufferOrDie(GTFS_ZIP_URL);
  try { fs.writeFileSync(TMP_GTFS_ZIP, buf); } catch {}
}

async function ensureStops() {
  if (stopsMem) return;
  if (fs.existsSync(STOPS_PATH)) {
    try { stopsMem = JSON.parse(fs.readFileSync(STOPS_PATH, 'utf-8')); return; } catch {}
  }
  await ensureGtfsZip();
  const zip = new AdmZip(TMP_GTFS_ZIP);
  const entry = zip.getEntry('stops.txt') || zip.getEntries().find(e => /(^|\/)stops\.txt$/i.test(e.entryName));
  if (!entry) throw new Error('stops.txt not found in GTFS zip');
  const csv = entry.getData().toString('utf-8');

  const rows = parseCsv(csv);
  const headers = rows.shift();
  const idx = Object.fromEntries(headers.map((h,i)=>[h,i]));

  stopsMem = rows.map(cols => ({
    stop_id: cols[idx.stop_id],
    stop_code: cols[idx.stop_code] || null,
    name: cols[idx.stop_name],
    lat: Number(cols[idx.stop_lat]),
    lon: Number(cols[idx.stop_lon]),
  })).filter(s => s.stop_id && Number.isFinite(s.lat) && Number.isFinite(s.lon));

  try { fs.writeFileSync(STOPS_PATH, JSON.stringify(stopsMem)); } catch {}
}

async function ensureRoutes() {
  if (routesMem) return;
  if (fs.existsSync(ROUTES_PATH)) {
    try { routesMem = JSON.parse(fs.readFileSync(ROUTES_PATH, 'utf-8')); return; } catch {}
  }
  await ensureGtfsZip();
  const zip = new AdmZip(TMP_GTFS_ZIP);
  const entry = zip.getEntry('routes.txt') || zip.getEntries().find(e => /(^|\/)routes\.txt$/i.test(e.entryName));
  if (!entry) throw new Error('routes.txt not found in GTFS zip');
  const csv = entry.getData().toString('utf-8');

  const rows = parseCsv(csv);
  const headers = rows.shift();
  const idx = Object.fromEntries(headers.map((h,i)=>[h,i]));

  routesMem = rows.map(cols => ({
    route_id: cols[idx.route_id],
    short_name: cols[idx.route_short_name] || '',
    long_name: cols[idx.route_long_name] || ''
  })).filter(r => r.route_id);

  try { fs.writeFileSync(ROUTES_PATH, JSON.stringify(routesMem)); } catch {}
}

const BASE = 'https://bustime.ttc.ca/gtfsrt';

async function fetchGtfsRt(url){
  const hit = getCache(url); if (hit) return hit;
  const buf = await fetchBufferOrDie(url);
  const FM = await loadProto();
  let object;
  try {
    const msg = FM.decode(buf);
    object = FM.toObject(msg, { longs: Number, enums: Number, defaults: false });
  } catch (e) {
    const err = new Error('Failed to decode GTFS-RT protobuf');
    err.details = e.message;
    err.status = 502;
    throw err;
  }
  putCache(url, object, 10_000);
  return object;
}

// ===== API =====
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get('/api/stops', async (_req,res)=>{
  try { await ensureStops(); res.json(stopsMem || []); }
  catch(e){ res.status(500).json({error:String(e), details:e.details||null}); }
});

app.get('/api/routes', async (_req,res)=>{
  try { await ensureRoutes(); res.json(routesMem || []); }
  catch(e){ res.status(500).json({error:String(e), details:e.details||null}); }
});

/**
 * Trip updates normalized for the client:
 * GET /api/trip-updates?stop_id=1234              (single)
 * GET /api/trip-updates?stop_id=1234,5678,9012    (multiple ok; client calls per-stop anyway)
 * Response: { stop_id: "1234", arrivals: [{ route_id, route_short_name, headsign?, arrival_time }] }
 */
app.get('/api/trip-updates', async (req,res)=>{
  res.setHeader('Content-Type','application/json');
  try {
    await ensureRoutes();
    const stopParam = (req.query.stop_id ?? req.query.stop ?? "").toString().trim();
    const stopIds = stopParam
      ? stopParam.split(',').map(s=>s.trim()).filter(Boolean)
      : []; // empty means "all" (but we'll still return per-stop objects)

    const feed = await fetchGtfsRt(`${BASE}/trips`);
    const byStop = new Map(); // stop_id -> array
    const routeShort = new Map(routesMem.map(r => [r.route_id, r.short_name || r.long_name || r.route_id]));

    for (const e of (feed.entity || [])) {
      const tu = e.tripUpdate || e.trip_update;
      if (!tu || !tu.stopTimeUpdate) continue;

      const trip = tu.trip || {};
      const routeId = trip.routeId || trip.route_id || null;
      const short = routeShort.get(routeId) || routeId || null;

      for (const stu of tu.stopTimeUpdate) {
        const sid = String(stu.stopId || stu.stop_id || "");
        if (!sid) continue;
        if (stopIds.length && !stopIds.includes(sid)) continue;

        const arrival =
          (stu.arrival && (Number(stu.arrival.time) || Number(stu.arrival.delay && 0))) ||
          (stu.departure && Number(stu.departure.time)) ||
          null;

        const arr = byStop.get(sid) || [];
        arr.push({
          route_id: routeId,
          route_short_name: short,
          headsign: null,          // not available in GTFS-RT; left null for client
          arrival_time: arrival,   // epoch seconds preferred by client
        });
        byStop.set(sid, arr);
      }
    }

    // If multiple were requested, return for the first one (client calls per stop)
    const pick = stopIds.length ? stopIds[0] : (byStop.keys().next().value || (stopIds[0] || null));
    const arrivals = (pick && byStop.get(pick)) ? byStop.get(pick) : [];
    // Sort soonest first
    arrivals.sort((a,b) => (a.arrival_time ?? Infinity) - (b.arrival_time ?? Infinity));

    res.json({ stop_id: pick || (stopIds[0] || null), arrivals });
  } catch(e){
    res.status(e.status || 500).json({ error: String(e), details: e.details || null });
  }
});

/**
 * Vehicles (simplified) for proximity fallback:
 * Response: [{ route_id, route_short_name?, headsign?, lat, lon, label? }]
 */
app.get('/api/vehicles', async (_req,res)=>{
  res.setHeader('Content-Type','application/json');
  try {
    await ensureRoutes();
    const feed = await fetchGtfsRt(`${BASE}/vehicles`);
    const routeShort = new Map(routesMem.map(r => [r.route_id, r.short_name || r.long_name || r.route_id]));

    const out = [];
    for (const e of (feed.entity || [])) {
      const veh = e.vehicle || e.vehiclePosition || {};
      if (!veh.position) continue;
      const trip = veh.trip || {};
      out.push({
        route_id: trip.routeId || trip.route_id || null,
        route_short_name: routeShort.get(trip.routeId || trip.route_id) || null,
        headsign: null,
        lat: Number(veh.position.latitude),
        lon: Number(veh.position.longitude),
        label: veh.vehicle && (veh.vehicle.label || veh.vehicle.id) || null,
      });
    }
    res.json(out);
  } catch(e){
    res.status(e.status || 500).json({ error: String(e), details: e.details || null });
  }
});

// Static & catch-all
app.use(express.static(PUBLIC_DIR));
app.get('*', (_req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Not found');
});

app.listen(PORT, async () => {
  try {
    await loadProto();
    await ensureStops();
    await ensureRoutes();
    console.log(`Open http://localhost:${PORT}`);
    console.log(`Data dir: ${DATA_DIR}`);
  } catch(e){
    console.error('Startup error:', e);
    console.error('If Node < 18, update Node or keep the fetch polyfill.');
  }
});
