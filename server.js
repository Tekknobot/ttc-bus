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

// **** Use a writable, ephemeral dir (serverless-friendly) ****
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

// tiny memory cache (API responses) + in-memory GTFS static data
const cache = new Map();
const getCache = (k)=>{ const v = cache.get(k); if(!v) return null; if(Date.now()>v.exp){cache.delete(k);return null;} return v.data; };
const putCache = (k,d,ttl=10000)=>cache.set(k,{data:d,exp:Date.now()+ttl});
let stopsMem = null;
let routesMem = null;

// Fetch helper
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

// CSV that handles quoted commas and escaped quotes
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
  // Best effort write; /tmp is writable on serverless
  try { fs.writeFileSync(TMP_GTFS_ZIP, buf); } catch { /* ignore */ }
}

async function ensureStops() {
  if (stopsMem) return;
  // Try reading from /tmp
  if (fs.existsSync(STOPS_PATH)) {
    try {
      stopsMem = JSON.parse(fs.readFileSync(STOPS_PATH, 'utf-8'));
      return;
    } catch { /* fall through to rebuild */ }
  }
  // Build from ZIP
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
    lon: Number(cols[idx.stop_lon])
  })).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));

  // Best effort cache to /tmp
  try { fs.writeFileSync(STOPS_PATH, JSON.stringify(stopsMem)); } catch { /* ignore */ }
}

async function ensureRoutes() {
  if (routesMem) return;
  if (fs.existsSync(ROUTES_PATH)) {
    try {
      routesMem = JSON.parse(fs.readFileSync(ROUTES_PATH, 'utf-8'));
      return;
    } catch { /* fall through */ }
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

  try { fs.writeFileSync(ROUTES_PATH, JSON.stringify(routesMem)); } catch { /* ignore */ }
}

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

app.get('/api/health', (_req, res) => {
  res.setHeader('Content-Type','application/json');
  res.json({ ok: true, ts: Date.now() });
});

app.get('/api/stops', async (_req,res)=>{
  res.setHeader('Content-Type','application/json');
  try { await ensureStops(); res.json(stopsMem || []); }
  catch(e){ res.status(500).json({error:String(e), details:e.details||null}); }
});

app.get('/api/routes', async (_req,res)=>{
  res.setHeader('Content-Type','application/json');
  try { await ensureRoutes(); res.json(routesMem || []); }
  catch(e){ res.status(500).json({error:String(e), details:e.details||null}); }
});

const BASE = 'https://bustime.ttc.ca/gtfsrt';

app.get('/api/trip-updates', async (req,res)=>{
  res.setHeader('Content-Type','application/json');
  try {
    const raw = (req.query.stop || '').toString();
    const stopSet = new Set(raw.split(',').map(s=>s.trim()).filter(Boolean));
    const feed = await fetchGtfsRt(`${BASE}/trips`);
    const updates = [];
    for (const e of feed.entity || []) {
      const tu = e.tripUpdate || e.trip_update;
      if (!tu || !tu.stopTimeUpdate) continue;
      const routeId = (tu.trip && (tu.trip.routeId || tu.trip.route_id)) || null;
      const tripId  = (tu.trip && (tu.trip.tripId  || tu.trip.trip_id )) || null;
      for (const stu of tu.stopTimeUpdate) {
        const stopId = stu.stopId || stu.stop_id;
        if (!stopSet.size || stopSet.has(stopId)) {
          const arrival = (stu.arrival && stu.arrival.time) || (stu.departure && stu.departure.time) || null;
          updates.push({ stopId, routeId, tripId, arrival });
        }
      }
    }
    res.json({ updates, matchedStops: Array.from(stopSet) });
  } catch(e){
    res.status(e.status || 500).json({ error: String(e), details: e.details || null });
  }
});

app.get('/api/vehicles', async (_req,res)=>{
  res.setHeader('Content-Type','application/json');
  try {
    const feed = await fetchGtfsRt(`${BASE}/vehicles`);
    res.json(feed);
  } catch(e){
    res.status(e.status || 500).json({ error: String(e), details: e.details || null });
  }
});

// tiny sanity check
app.get('/api/debug-rt', async (_req, res) => {
  try {
    const v = await fetchGtfsRt(`${BASE}/vehicles`);
    const t = await fetchGtfsRt(`${BASE}/trips`);
    res.json({
      ok: true,
      vehicles_sample: (v.entity || []).slice(0, 3).map(e => e.id),
      trips_sample: (t.entity || []).slice(0, 3).map(e => e.id),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e), details: e.details || null });
  }
});

// Static files (fine on serverless if bundled in /public)
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
