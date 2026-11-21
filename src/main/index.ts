// Jetrover mission agent, main side.
//
// A local HTTP control port so behaviours can be driven from scripts (and later from the agent on
// the strixbox). Movement is standard MAVLink Guided setpoints, only while the rover is armed and
// in Guided:
//  * through Ardudeck's host.vehicle.setpoint when the host supports the vehicle type, else
//  * through the module's own MAVLink link (mavlink.ts) behind the same gate (gate.ts), because
//    stock Ardudeck's module API refuses motion for rovers and we don't patch Ardudeck.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { MainHostApi, MavlinkFrame, VehicleSetpoint, VehicleSetpointResult } from '@ardudeck/module-sdk';
import { MavLink, MSG, commandLongPayload, setpointPayload } from './mavlink.js';
import { motionRefusal } from './gate.js';

const PORT = Number(process.env['JETROVER_AGENT_PORT'] ?? 8765);
const HOST = '127.0.0.1';
// Where the vehicle's MAVLink reaches this laptop for the agent. On the real rover that's the
// Jetson bridge's spare output (udp:<tuxbox>:14562).
const [MAV_BIND_HOST, MAV_BIND_PORT] = (process.env['JETROVER_MAV_LISTEN'] ?? '0.0.0.0:14562').split(':');
const MIN_SETPOINT_INTERVAL_MS = 20;
const VEL_BODY_MASK = 0b0000_0101_1100_0111; // velocity + yaw rate
const POS_GLOBAL_MASK = 0b0000_1101_1111_1000; // position only
const SETPOINT_HZ = 10;
const MAV_TYPE_GCS = 6;

interface Telemetry {
  customMode?: number;
  armed?: boolean;
  mavType?: number;
  groundspeed?: number;
  heading?: number;
  lat?: number;
  lon?: number;
  at?: number;
}

let host: MainHostApi;
let server: Server | null = null;
let unsubscribe: (() => void) | null = null;
let link: MavLink | null = null;
let lastPath: 'ardudeck' | 'agent link' | null = null;
let lastSetpointAt = 0;
const telemetry: Telemetry = {};

/** Send one Guided setpoint, through Ardudeck if it supports the vehicle, else our own link. */
async function setpoint(sp: VehicleSetpoint): Promise<VehicleSetpointResult> {
  const hs = host.vehicle.getGuidedState();
  if (hs.connected && hs.vehicleClass !== 'other') {
    lastPath = 'ardudeck';
    return host.vehicle.setpoint(sp);
  }
  lastPath = 'agent link';
  if (!link) return { ok: false, error: 'agent link not open' };
  const refusal = motionRefusal({ now: Date.now(), heartbeats: link.heartbeats, host: hs });
  if (refusal) return { ok: false, error: refusal };
  const values = sp.kind === 'velocityBody' ? [sp.forward, sp.right, sp.down, sp.yawRate] : [sp.latitude, sp.longitude, sp.altitude];
  if (!values.every(Number.isFinite)) return { ok: false, error: 'non-finite setpoint' };
  const now = Date.now();
  if (now - lastSetpointAt < MIN_SETPOINT_INTERVAL_MS) return { ok: false, error: 'too fast' };
  lastSetpointAt = now;
  const target = { targetSystem: hs.sysid!, targetComponent: 1, yaw: 0 };
  const ok = sp.kind === 'velocityBody'
    ? await link.send(MSG.SET_POSITION_TARGET_LOCAL_NED, setpointPayload(84, {
      ...target, frame: 9, typeMask: VEL_BODY_MASK, x: 0, y: 0, z: 0,
      vx: sp.forward, vy: sp.right, vz: sp.down, yawRate: sp.yawRate,
    }))
    : await link.send(MSG.SET_POSITION_TARGET_GLOBAL_INT, setpointPayload(86, {
      ...target, frame: 6, typeMask: POS_GLOBAL_MASK,
      x: Math.round(sp.latitude * 1e7), y: Math.round(sp.longitude * 1e7), z: sp.altitude,
      vx: 0, vy: 0, vz: 0, yawRate: 0,
    }));
  return ok ? { ok: true } : { ok: false, error: 'agent link is closed' };
}

const MAV_CMD_DO_CHANGE_SPEED = 178;
const ACK_TIMEOUT_MS = 1500;
const pendingAcks = new Map<number, (result: number) => void>();

/**
 * Set the Guided speed (MAV_CMD_DO_CHANGE_SPEED, ground speed in m/s). ArduRover applies it to
 * position targets in Guided, so `goto` respects the mission's speed limit.
 */
async function changeSpeed(speedMps: number): Promise<{ ok: boolean; error?: string }> {
  if (!(speedMps > 0) || !Number.isFinite(speedMps)) return { ok: false, error: 'speed must be a positive number' };
  const params = [1, speedMps, -1, 0]; // ground speed, m/s, throttle unchanged, absolute
  const hs = host.vehicle.getGuidedState();
  if (hs.connected && hs.vehicleClass !== 'other') {
    const r = await host.vehicle.command({ command: MAV_CMD_DO_CHANGE_SPEED, params });
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'refused' };
  }
  if (!link) return { ok: false, error: 'agent link not open' };
  const refusal = motionRefusal({ now: Date.now(), heartbeats: link.heartbeats, host: hs });
  if (refusal) return { ok: false, error: refusal };
  const ack = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { pendingAcks.delete(MAV_CMD_DO_CHANGE_SPEED); resolve(null); }, ACK_TIMEOUT_MS);
    pendingAcks.set(MAV_CMD_DO_CHANGE_SPEED, (r) => { clearTimeout(timer); resolve(r); });
  });
  const sent = await link.send(MSG.COMMAND_LONG, commandLongPayload({ command: MAV_CMD_DO_CHANGE_SPEED, params, targetSystem: hs.sysid!, targetComponent: 1 }));
  if (!sent) { pendingAcks.delete(MAV_CMD_DO_CHANGE_SPEED); return { ok: false, error: 'agent link is closed' }; }
  const result = await ack;
  if (result === null) return { ok: false, error: 'no answer from the vehicle to the speed change' };
  return result === 0 ? { ok: true } : { ok: false, error: `vehicle refused the speed change (MAV_RESULT ${result})` };
}

/** MAVLink 2 trims trailing zero bytes from payloads: pad before reading fixed offsets. */
function view(frame: MavlinkFrame, len: number): DataView {
  const buf = new Uint8Array(Math.max(len, frame.payload.length));
  buf.set(frame.payload);
  return new DataView(buf.buffer);
}

function onFrame(frame: MavlinkFrame): void {
  if (frame.msgid === 0) {
    const v = view(frame, 9);
    const mavType = v.getUint8(4);
    if (mavType === MAV_TYPE_GCS) return;
    telemetry.customMode = v.getUint32(0, true);
    telemetry.mavType = mavType;
    telemetry.armed = (v.getUint8(6) & 0x80) !== 0;
  } else if (frame.msgid === 74) {
    const v = view(frame, 20); // VFR_HUD
    telemetry.groundspeed = v.getFloat32(4, true);
    telemetry.heading = v.getInt16(16, true);
  } else if (frame.msgid === 33) {
    const v = view(frame, 28); // GLOBAL_POSITION_INT
    telemetry.lat = v.getInt32(4, true) / 1e7;
    telemetry.lon = v.getInt32(8, true) / 1e7;
  } else {
    return;
  }
  telemetry.at = Date.now();
}

function status() {
  const hs = host.vehicle.getGuidedState();
  const viaHost = hs.connected && hs.vehicleClass !== 'other';
  const refusal = viaHost
    ? (hs.armed && hs.guided ? null : 'needs armed + Guided')
    : link ? motionRefusal({ now: Date.now(), heartbeats: link.heartbeats, host: hs }) : 'agent link not open';
  return {
    guided: hs,
    canDrive: refusal === null,
    refusal,
    path: lastPath,
    link: link ? { describe: link.describe, error: link.error } : null,
    telemetry: { ...telemetry },
    behaviour: current?.name ?? null,
  };
}

// --- behaviours -----------------------------------------------------------------------------

interface Running { name: string; cancelled: boolean }
let current: Running | null = null;

function startBehaviour(name: string): Running {
  if (current) current.cancelled = true;
  current = { name, cancelled: false };
  return current;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function velocity(forward: number, yawRate: number, seconds: number) {
  const run = startBehaviour(`velocity ${forward} m/s, ${yawRate} rad/s`);
  const sp: VehicleSetpoint = { kind: 'velocityBody', forward, right: 0, down: 0, yawRate };
  let sent = 0;
  let firstError: string | null = null;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end && !run.cancelled) {
    const r = await setpoint(sp);
    if (r.ok) sent++;
    else if (!firstError) firstError = r.error ?? 'refused';
    if (!r.ok && r.error !== 'too fast') break; // gate refused: stop, don't keep hammering
    await sleep(1000 / SETPOINT_HZ);
  }
  if (current === run) current = null;
  return { sent, error: firstError, cancelled: run.cancelled, ...status() };
}

async function goto(lat: number, lon: number, speedMps?: number) {
  startBehaviour(`goto ${lat.toFixed(6)}, ${lon.toFixed(6)}${speedMps ? ` at ${speedMps} m/s` : ''}`);
  const r = await setpoint({ kind: 'positionGlobal', latitude: lat, longitude: lon, altitude: 0 });
  if (!r.ok || speedMps === undefined) return { ...r, target: { lat, lon }, speed_mps: null, ...status() };
  // ArduRover only accepts DO_CHANGE_SPEED in Guided once it is driving to a target (verified in
  // SITL: refused with MAV_RESULT_FAILED before), so the target goes first. If the speed can't be
  // set, stop at once rather than let the rover run at cruise speed.
  const sp = await changeSpeed(speedMps);
  if (!sp.ok) {
    await stop();
    return { ok: false, error: `stopped: ${sp.error}`, target: { lat, lon }, ...status() };
  }
  return { ...r, target: { lat, lon }, speed_mps: speedMps, ...status() };
}

async function stop() {
  if (current) current.cancelled = true;
  current = null;
  const r = await setpoint({ kind: 'velocityBody', forward: 0, right: 0, down: 0, yawRate: 0 });
  return { ...r, ...status() };
}

// --- HTTP control port ------------------------------------------------------------------------

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const num = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
};

function offset(lat: number, lon: number, north: number, east: number) {
  return { lat: lat + north / 111_320, lon: lon + east / (111_320 * Math.cos((lat * Math.PI) / 180)) };
}

async function route(req: IncomingMessage): Promise<unknown> {
  const url = req.url ?? '/';
  if (req.method === 'GET' && url === '/status') return status();
  if (req.method !== 'POST') throw Object.assign(new Error('not found'), { code: 404 });
  const b = await body(req);
  switch (url) {
    case '/velocity':
      return velocity(num(b['forward'], 'forward'), num(b['yawRate'] ?? 0, 'yawRate'), num(b['seconds'], 'seconds'));
    case '/goto': {
      const speed = b['speed'] === undefined ? undefined : num(b['speed'], 'speed');
      if (b['north'] !== undefined || b['east'] !== undefined) {
        if (telemetry.lat === undefined || telemetry.lon === undefined) throw new Error('no position yet');
        const t = offset(telemetry.lat, telemetry.lon, num(b['north'] ?? 0, 'north'), num(b['east'] ?? 0, 'east'));
        return goto(t.lat, t.lon, speed);
      }
      return goto(num(b['lat'], 'lat'), num(b['lon'], 'lon'), speed);
    }
    case '/stop':
      return stop();
    default:
      throw Object.assign(new Error('not found'), { code: 404 });
  }
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  route(req)
    .then((out) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    })
    .catch((err: Error & { code?: number }) => {
      res.writeHead(err.code ?? 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
}

export async function activate(h: MainHostApi) {
  host = h;
  unsubscribe = host.mavlink.subscribe([0, 33, 74], onFrame);
  link = new MavLink(MAV_BIND_HOST ?? '0.0.0.0', Number(MAV_BIND_PORT ?? 14562));
  link.onFrame = (f) => {
    if (f.msgid === MSG.COMMAND_ACK) {
      const resolve = pendingAcks.get(f.payload.getUint16(0, true));
      if (resolve) { pendingAcks.delete(f.payload.getUint16(0, true)); resolve(f.payload.getUint8(2)); }
    }
  };
  link.open((msg) => host.log('info', msg));
  host.onRendererMessage('status', () => status());
  host.onRendererMessage('stop', () => stop());
  server = createServer(handle);
  server.on('error', (err) => host.log('error', `control port ${HOST}:${PORT}: ${err.message}`));
  server.listen(PORT, HOST, () => host.log('info', `control port listening on http://${HOST}:${PORT}`));
}

export function deactivate() {
  if (current) current.cancelled = true;
  unsubscribe?.();
  link?.close();
  link = null;
  server?.close();
  server = null;
}
