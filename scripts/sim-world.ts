#!/usr/bin/env node
// Simulated perception for SITL: red balls on the field, camera + Ferret detections, pushing.
//
//   node scripts/sim-world.ts [--balls 3] [--seed 1] [--no-plow] [--no-ferret] [--port 8766]
//                             [--addon <design.json>] [--corner <east>,<north>]
//
// --addon takes the plow's mouth width and depth from a SolidCraft design (scripts/plan.ts design);
// --corner is the drop corner in metres east/north of home (default 9,9).
//
// Follows the rover through the module's control port (/status, ~10 Hz) and serves:
//   GET  /detections   what the rover's camera and Ferret see right now (body frame)
//   GET  /world        ground truth: every ball with lat/lon (for scoring and debugging)
//   POST /reset        {"balls": n, "seed": s, "plow": true, "ferret": true}
// Balls are placed at random inside the sitl-balls field (see makeWorld).

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, World, rng, type Pose, type SimBall, type WorldConfig } from '../sim/world.ts';

const HOME: [number, number] = [-35.363261, 149.16523];
const M_PER_DEG_LAT = 111_320;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((HOME[0] * Math.PI) / 180);
const toLocal = (lat: number, lon: number) => ({ east: (lon - HOME[1]) * mPerDegLon, north: (lat - HOME[0]) * M_PER_DEG_LAT });
const toLatLon = (east: number, north: number) => ({ lat: HOME[0] + north / M_PER_DEG_LAT, lon: HOME[1] + east / mPerDegLon });

function arg(name: string, def?: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const port = Number(arg('--port', '8766'));
const agent = arg('--agent', 'http://127.0.0.1:8765')!;

// Balls go into the sitl-balls mission's field (scripts/sitl-mission.ts balls): east/north
// 0..10 m from home, at least 2.5 m from the drop corner (9, 9), 1.5 m from home and 2 m apart.
const [ce, cn] = (process.argv.includes('--corner') ? process.argv[process.argv.indexOf('--corner') + 1]! : '9,9').split(',').map(Number);
const CORNER = { east: ce!, north: cn! };

function makeWorld(n: number, seed: number, plow: boolean, ferret: boolean): World {
  const r = rng(seed * 7);
  const balls: SimBall[] = [];
  while (balls.length < n) {
    const east = r.next() * 10;
    const north = r.next() * 10;
    if (Math.hypot(east - CORNER.east, north - CORNER.north) < 2.5 || Math.hypot(east, north) < 1.5 || balls.some((b) => Math.hypot(b.east - east, b.north - north) < 2)) continue;
    balls.push({ id: `ball${balls.length + 1}`, east, north, r: 0.03 });
  }
  const cfg: WorldConfig = { ...DEFAULT_CONFIG, seed, plow: { ...DEFAULT_CONFIG.plow, fitted: plow, ...addonPlow() }, ferret: { ...DEFAULT_CONFIG.ferret, enabled: ferret } };
  return new World(balls, cfg);
}

/** Plow geometry from a SolidCraft design, if one is given. */
function addonPlow(): Partial<WorldConfig['plow']> {
  const path = arg('--addon');
  if (!path) return {};
  const d = JSON.parse(readFileSync(path, 'utf-8')) as { name: string; functional: Record<string, unknown> };
  const f = d.functional;
  const pick = (...keys: string[]) => keys.map((k) => Number(f[k])).find((v) => v > 0);
  const w = pick('mouth_width_mm', 'throat_width_mm', 'pocket_width_mm');
  const dp = pick('mouth_depth_mm', 'funnel_depth_mm', 'depth_mm', 'pocket_depth_mm');
  const entry = pick('entry_width_mm', 'working_width_mm', 'working_width_ground_mm', 'flare_width_mm', 'outer_width_mm', 'opening_width_mm');
  if (!w || !dp) throw new Error(`${path}: no mouth width / depth in functional (${Object.keys(f).join(', ')})`);
  console.log(`plow from ${d.name}: mouth ${w} mm, depth ${dp} mm${entry ? `, entry ${entry} mm` : ''}`);
  return { fitted: true, width_m: w / 1000, depth_m: dp / 1000, ...(entry ? { entry_width_m: entry / 1000 } : {}) };
}

let world = makeWorld(Number(arg('--balls', '3')), Number(arg('--seed', '1')), !process.argv.includes('--no-plow'), !process.argv.includes('--no-ferret'));
let pose: Pose | null = null;

async function poll() {
  try {
    const res = await fetch(`${agent}/status`, { signal: AbortSignal.timeout(1000) });
    const st = (await res.json()) as { telemetry: { lat?: number; lon?: number; heading?: number; groundspeed?: number } };
    const t = st.telemetry;
    if (t.lat !== undefined && t.lon !== undefined && t.heading !== undefined) {
      pose = { ...toLocal(t.lat, t.lon), heading_deg: t.heading, speed: t.groundspeed ?? 0 };
      world.step(pose);
    }
  } catch { /* module not up yet */ }
}
setInterval(poll, 100);

function worldView() {
  return {
    pose: pose ? { ...toLatLon(pose.east, pose.north), heading_deg: pose.heading_deg } : null,
    plow: world.cfg.plow.fitted,
    ferret: world.cfg.ferret.enabled,
    balls: world.balls.map((b) => ({ id: b.id, ...toLatLon(b.east, b.north), east: +b.east.toFixed(2), north: +b.north.toFixed(2) })),
  };
}

createServer(async (req, res) => {
  const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && req.url === '/detections') return send(200, { at: Date.now(), detections: pose ? world.detections(pose) : [] });
    if (req.method === 'GET' && req.url === '/world') return send(200, { ...worldView(), corner_distances_m: cornerDistances() });
    if (req.method === 'POST' && req.url === '/reset') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const b = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { balls?: number; seed?: number; plow?: boolean; ferret?: boolean };
      world = makeWorld(b.balls ?? 3, b.seed ?? 1, b.plow ?? true, b.ferret ?? true);
      return send(200, worldView());
    }
    send(404, { error: 'not found' });
  } catch (err) {
    send(400, { error: (err as Error).message });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`sim world on http://127.0.0.1:${port}, following ${agent}`);
  console.log(JSON.stringify(worldView().balls));
});

/** Ground truth for scoring: each ball's distance from the drop corner. */
export function cornerDistances() {
  return world.balls.map((b) => ({ id: b.id, m: +Math.hypot(b.east - CORNER.east, b.north - CORNER.north).toFixed(2) }));
}
