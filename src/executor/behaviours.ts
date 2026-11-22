// The executor's behaviours. Each one moves the rover only through the control port (Guided
// setpoints), has its own completion check and timeout, and calls ctx.guard() every poll so the
// mission monitors and the operator's takeover always apply.

import type { MissionSpec, SpecStep } from '../planning/spec.ts';
import type { AgentClient, AgentStatus } from './client.ts';
import type { Detection, PerceptionClient } from './perception.ts';
import { distanceM, insidePolygon, type LatLon } from './geo.ts';

export class Abort extends Error {}
export class Restart extends Error {}

export type StepOutcome =
  | { kind: 'done'; detail?: string }
  /** The object isn't really there (a false sighting): give it up without a decision. */
  | { kind: 'dismiss'; reason: string }
  | { kind: 'failed'; failure: string }
  | { kind: 'restart' }
  | { kind: 'abort'; reason: string };

export interface TrackedObject {
  id: string;
  lat: number;
  lon: number;
  sightings: number;
  status: 'found' | 'delivered' | 'skipped';
}

/**
 * Objects found during the mission. Sightings are merged into the nearest object within a
 * range-dependent radius and averaged with weight 1/range², since camera range error grows with
 * distance: one close sighting outweighs several far ones.
 */
export class ObjectRegistry {
  objects: TrackedObject[] = [];
  private n = 0;
  private weights = new Map<string, number>();

  add(lat: number, lon: number, range = 1, status: TrackedObject['status'] = 'found'): TrackedObject {
    const mergeM = 0.6 + 0.15 * range;
    const w = 1 / Math.max(range, 0.5) ** 2;
    let near: TrackedObject | undefined;
    let best = Infinity;
    for (const o of this.objects) {
      const d = distanceM(o.lat, o.lon, lat, lon);
      if (d < mergeM && d < best) { best = d; near = o; }
    }
    if (near) {
      const W = this.weights.get(near.id)!;
      near.lat = (near.lat * W + lat * w) / (W + w);
      near.lon = (near.lon * W + lon * w) / (W + w);
      this.weights.set(near.id, W + w);
      near.sightings++;
      return near;
    }
    const o: TrackedObject = { id: `obj${++this.n}`, lat, lon, sightings: 1, status };
    this.objects.push(o);
    this.weights.set(o.id, w);
    return o;
  }

  /** Objects seen often enough to be trusted (filters single noisy sightings). */
  confirmed(minSightings = 2) {
    return this.objects.filter((o) => o.sightings >= minSightings);
  }
}

export interface Ctx {
  spec: MissionSpec;
  client: AgentClient;
  perception: PerceptionClient;
  objects: ObjectRegistry;
  /** The object a for_each block is working on. */
  current: TrackedObject | null;
  /** Set once the Ferret has reported anything this run. */
  ferretSeen: boolean;
  /** Areas point-to-point driving routes around (the delivery zone, so the pile isn't bulldozed). */
  keepOut: Array<{ lat: number; lon: number; r: number }>;
  guard(): Promise<AgentStatus>;
  log(type: string, data?: Record<string, unknown>): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  pollMs: number;
}

// --- geometry --------------------------------------------------------------------------------

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const M_LAT = 111_320;
const mLon = (lat: number) => M_LAT * Math.cos(rad(lat));
const wrap = (d: number) => ((d + 540) % 360) - 180;
const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

interface RoverPose { lat: number; lon: number; heading: number; speed: number }

function poseOf(st: AgentStatus): RoverPose | null {
  const t = st.telemetry;
  if (t.lat === undefined || t.lon === undefined || t.heading === undefined) return null;
  return { lat: t.lat, lon: t.lon, heading: t.heading, speed: t.groundspeed ?? 0 };
}

export function bodyToLatLon(p: RoverPose, forward: number, right: number): { lat: number; lon: number } {
  const h = rad(p.heading);
  const east = forward * Math.sin(h) + right * Math.cos(h);
  const north = forward * Math.cos(h) - right * Math.sin(h);
  return { lat: p.lat + north / M_LAT, lon: p.lon + east / mLon(p.lat) };
}

export function latLonToBody(p: RoverPose, lat: number, lon: number): { forward: number; right: number } {
  const h = rad(p.heading);
  const north = (lat - p.lat) * M_LAT;
  const east = (lon - p.lon) * mLon(p.lat);
  return { forward: east * Math.sin(h) + north * Math.cos(h), right: east * Math.cos(h) - north * Math.sin(h) };
}

/** Bearing from the rover to a point, relative to its heading (deg, + right). */
function relBearing(p: RoverPose, lat: number, lon: number): number {
  const b = deg(Math.atan2((lon - p.lon) * mLon(p.lat), (lat - p.lat) * M_LAT));
  return wrap(b - p.heading);
}

function offset(lat: number, lon: number, north: number, east: number) {
  return { lat: lat + north / M_LAT, lon: lon + east / mLon(lat) };
}

function targetOf(v: unknown): { lat: number; lon: number } | undefined {
  const t = v as { lat?: unknown; lon?: unknown } | undefined;
  const lat = num(t?.lat);
  const lon = num(t?.lon);
  return lat !== undefined && lon !== undefined ? { lat, lon } : undefined;
}

// --- shared pieces ---------------------------------------------------------------------------

async function look(ctx: Ctx, _st: AgentStatus, sources: Array<Detection['source']> = ['camera']): Promise<Detection[]> {
  let dets: Detection[] = [];
  try { dets = await ctx.perception.detections(); } catch { /* perception down: see nothing */ }
  if (dets.some((d) => d.source === 'ferret')) ctx.ferretSeen = true;
  return dets.filter((d) => sources.includes(d.source));
}

/** Register camera sightings as map objects. */
function register(registry: ObjectRegistry, p: RoverPose, dets: Detection[], maxRange = 4) {
  for (const d of dets) {
    if (d.source !== 'camera' || d.range_m > maxRange) continue;
    const w = bodyToLatLon(p, d.forward_m, d.right_m);
    registry.add(w.lat, w.lon, d.range_m);
  }
}

/**
 * A detour point if the straight line from a to b crosses a keep-out circle (and neither end is
 * inside it): beside the circle, on the side the line passes, clear by 0.4 m.
 */
export function detour(a: { lat: number; lon: number }, b: { lat: number; lon: number }, zones: Ctx['keepOut']): { lat: number; lon: number } | null {
  for (const z of zones) {
    const P = (q: { lat: number; lon: number }) => ({ x: (q.lon - z.lon) * mLon(z.lat), y: (q.lat - z.lat) * M_LAT });
    const A = P(a);
    const B = P(b);
    if (Math.hypot(A.x, A.y) < z.r || Math.hypot(B.x, B.y) < z.r) continue;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / L2));
    const cx = A.x + t * dx;
    const cy = A.y + t * dy;
    const d = Math.hypot(cx, cy);
    if (d >= z.r) continue;
    // push the closest point out to the circle's edge (+0.4 m), on its own side of the centre
    const nx = d > 1e-3 ? cx / d : -dy / Math.sqrt(L2);
    const ny = d > 1e-3 ? cy / d : dx / Math.sqrt(L2);
    const k = z.r + 0.4;
    return { lat: z.lat + (ny * k) / M_LAT, lon: z.lon + (nx * k) / mLon(z.lat) };
  }
  return null;
}

/** Drive to a point with goto, around keep-out zones; onPoll runs every poll (e.g. to look around). */
async function driveTo(
  ctx: Ctx, lat: number, lon: number,
  o: { speed: number; radius: number; timeoutS?: number; onPoll?: PollFn },
): Promise<StepOutcome> {
  if (ctx.keepOut.length) {
    const t0 = (await ctx.guard()).telemetry;
    if (t0.lat !== undefined && t0.lon !== undefined) {
      const via = detour({ lat: t0.lat, lon: t0.lon }, { lat, lon }, ctx.keepOut);
      if (via && insidePolygon(via.lat, via.lon, ctx.spec.geofence)) {
        ctx.log('detour', { around: 'keep-out zone', ...via });
        const out = await driveLeg(ctx, via.lat, via.lon, { ...o, radius: Math.max(o.radius, 0.8), timeoutS: undefined });
        if (out.kind !== 'done') return out;
      }
    }
  }
  return driveLeg(ctx, lat, lon, o);
}

/** Called every poll while driving; may return a point to sidestep through first. */
type PollFn = (st: AgentStatus, p: RoverPose) => Promise<{ via: { lat: number; lon: number } } | void>;

async function driveLeg(
  ctx: Ctx, lat: number, lon: number,
  o: { speed: number; radius: number; timeoutS?: number; onPoll?: PollFn },
): Promise<StepOutcome> {
  const st0 = await ctx.guard();
  const t0 = st0.telemetry;
  const d0 = t0.lat !== undefined && t0.lon !== undefined ? distanceM(t0.lat, t0.lon, lat, lon) : 0;
  const timeoutMs = (o.timeoutS ?? d0 / o.speed * 2.5 + 20) * 1000;
  const r = await ctx.client.goto(lat, lon, o.speed);
  if (r.ok === false) return { kind: 'failed', failure: `goto refused: ${r.error ?? 'unknown'}` };
  const deadline = ctx.now() + timeoutMs;
  let stillSince: number | null = null;
  for (;;) {
    await ctx.sleep(ctx.pollMs);
    const st = await ctx.guard();
    const t = st.telemetry;
    if (t.lat === undefined || t.lon === undefined) { if (ctx.now() > deadline) return { kind: 'failed', failure: 'no position telemetry' }; continue; }
    const p = poseOf(st);
    if (o.onPoll && p) {
      const ask = await o.onPoll(st, p);
      if (ask) {
        // sidestep, then carry on to the original target
        const r1 = await ctx.client.goto(ask.via.lat, ask.via.lon, o.speed);
        if (r1.ok === false) return { kind: 'failed', failure: `goto refused: ${r1.error ?? 'unknown'}` };
        for (let i = 0; i < 60; i++) {
          await ctx.sleep(ctx.pollMs);
          const s2 = (await ctx.guard()).telemetry;
          if (s2.lat !== undefined && s2.lon !== undefined && distanceM(s2.lat, s2.lon, ask.via.lat, ask.via.lon) < 0.4) break;
        }
        const r2 = await ctx.client.goto(lat, lon, o.speed);
        if (r2.ok === false) return { kind: 'failed', failure: `goto refused: ${r2.error ?? 'unknown'}` };
        continue;
      }
    }
    const d = distanceM(t.lat, t.lon, lat, lon);
    if (d <= o.radius) {
      // Within the step's radius: stop here. ArduPilot would carry on to the point itself, so a
      // stand-off radius (look at a pile from 2.5 m) only holds if we stop the rover ourselves.
      if ((t.groundspeed ?? 0) >= 0.3) await ctx.client.stop();
      return { kind: 'done', detail: `arrived, ${d.toFixed(1)} m from target` };
    }
    // ArduPilot counts a position target as reached within WP_RADIUS and parks there; when that
    // is wider than the step's radius the rover stops short. Close the rest with velocity.
    if (p && (t.groundspeed ?? 0) < 0.05) {
      stillSince ??= ctx.now();
      if (ctx.now() - stillSince >= 3000) {
        ctx.log('close_in', { left_m: +d.toFixed(2), why: 'stopped short of the target (vehicle WP_RADIUS wider than the step radius?)' });
        return closeIn(ctx, lat, lon, o.radius, Math.min(o.speed, 0.3), deadline, timeoutMs);
      }
    } else {
      stillSince = null;
    }
    if (ctx.now() > deadline) return { kind: 'failed', failure: `did not arrive within ${Math.round(timeoutMs / 1000)} s, ${d.toFixed(1)} m left` };
  }
}

/** Drive the last stretch to a point with body-velocity setpoints (turn toward it, then creep). */
async function closeIn(ctx: Ctx, lat: number, lon: number, radius: number, speed: number, deadline: number, timeoutMs: number): Promise<StepOutcome> {
  for (;;) {
    const st = await ctx.guard();
    const p = poseOf(st);
    if (!p) return { kind: 'failed', failure: 'no position telemetry' };
    const d = distanceM(p.lat, p.lon, lat, lon);
    if (d <= radius) {
      await ctx.client.stop();
      return { kind: 'done', detail: `arrived, ${d.toFixed(1)} m from target (closed in with velocity)` };
    }
    if (ctx.now() > deadline) return { kind: 'failed', failure: `did not arrive within ${Math.round(timeoutMs / 1000)} s, ${d.toFixed(1)} m left` };
    const err = relBearing(p, lat, lon);
    const yaw = Math.max(-0.5, Math.min(0.5, rad(err) * 1.5));
    const forward = Math.abs(err) < 25 ? Math.min(speed, d) : 0;
    const e = await nudge(ctx, forward, yaw, 0.5);
    if (e) return { kind: 'failed', failure: `velocity refused: ${e}` };
  }
}

/** Short burst of body velocity (the control port streams it at 10 Hz). */
async function nudge(ctx: Ctx, forward: number, yawRate: number, seconds: number): Promise<string | null> {
  const r = await ctx.client.velocity(forward, yawRate, seconds);
  // the module skips a setpoint sent < 20 ms after the previous one ("too fast"); older module
  // versions reported that as an error although the rest went through
  if (r.error === 'too fast' && (r.sent ?? 0) > 0) return null;
  return r.error ?? null;
}

// --- behaviours ------------------------------------------------------------------------------

export async function gotoBehaviour(ctx: Ctx, step: SpecStep): Promise<StepOutcome> {
  const p = step.params;
  const t = targetOf(p['target'] ?? p['destination'] ?? p['waypoint']) ?? targetOf(p);
  if (!t) return { kind: 'failed', failure: 'goto has no target coordinates' };
  const speed = Math.min(num(p['max_speed_mps']) ?? num(p['speed_mps']) ?? ctx.spec.limits.max_speed_mps, ctx.spec.limits.max_speed_mps);
  ctx.log('goto', { step: step.id, ...t, speed });
  return driveTo(ctx, t.lat, t.lon, { speed, radius: num(p['arrival_radius_m']) ?? 2.0, timeoutS: num(p['timeout_s']) });
}

export async function velocityBehaviour(ctx: Ctx, step: SpecStep): Promise<StepOutcome> {
  const p = step.params;
  const limit = ctx.spec.limits.max_speed_mps;
  const forward = clamp(num(p['forward_mps']) ?? num(p['forward']) ?? 0, limit);
  const yaw = num(p['yaw_rate_rps']) ?? num(p['yawRate']) ?? 0;
  const seconds = num(p['seconds']) ?? num(p['duration_s']);
  if (seconds === undefined || seconds <= 0) return { kind: 'failed', failure: 'velocity has no duration' };
  let remaining = seconds;
  while (remaining > 0) {
    await ctx.guard();
    const chunk = Math.min(1, remaining);
    const err = await nudge(ctx, forward, yaw, chunk);
    if (err) return { kind: 'failed', failure: `velocity refused: ${err}` };
    remaining -= chunk;
  }
  return { kind: 'done', detail: `${seconds} s at ${forward} m/s, ${yaw} rad/s` };
}

export async function stopBehaviour(ctx: Ctx): Promise<StepOutcome> {
  await ctx.guard();
  await ctx.client.stop();
  return { kind: 'done' };
}

/**
 * Lawnmower legs inside the geofence, registering camera detections as objects.
 * params: spacing_m (2.0), margin_m (1.5), speed_mps, mode ("find" | "verify"),
 *         target + radius_m (objects there count as delivered; in verify mode, anything found
 *         outside it fails the step).
 */
export async function surveyBehaviour(ctx: Ctx, step: SpecStep): Promise<StepOutcome> {
  const p = step.params;
  const poly = ctx.spec.geofence;
  if (poly.length < 3) return { kind: 'failed', failure: 'survey needs a geofence polygon' };
  // 2 m: the forward-only camera (45°) sees about +-1.2 m to the side at 3 m; wider spacing
  // leaves strips of the field unseen. Panning the gimbal would allow more.
  const spacing = num(p['spacing_m']) ?? 2.0;
  const margin = num(p['margin_m']) ?? 1.5;
  const speed = Math.min(num(p['speed_mps']) ?? num(p['max_speed_mps']) ?? ctx.spec.limits.max_speed_mps, ctx.spec.limits.max_speed_mps);
  const verify = p['mode'] === 'verify';
  const zone = targetOf(p['target']);
  const zoneR = num(p['radius_m']) ?? 1.0;

  // legs north-south across the polygon's bounding box, inset by the margin
  const [lat0, lon0] = poly[0]!;
  const local = poly.map(([la, lo]) => ({ north: (la - lat0) * M_LAT, east: (lo - lon0) * mLon(lat0) }));
  const minE = Math.min(...local.map((q) => q.east)) + margin;
  const maxE = Math.max(...local.map((q) => q.east)) - margin;
  const minN = Math.min(...local.map((q) => q.north)) + margin;
  const maxN = Math.max(...local.map((q) => q.north)) - margin;
  // keep out of the target zone (don't bulldoze what was already delivered): cut each leg
  // around a circle of radius + 0.7 m around it (rover half-width + plow + margin)
  const keepOut = zone ? { north: (zone.lat - lat0) * M_LAT, east: (zone.lon - lon0) * mLon(lat0), r: zoneR + 0.7 } : null;
  const waypoints: LatLon[] = [];
  let up = true;
  for (let e = minE; e <= maxE + 1e-6; e += spacing) {
    let segs: Array<[number, number]> = [[minN, maxN]];
    if (keepOut && Math.abs(e - keepOut.east) < keepOut.r) {
      const h = Math.sqrt(keepOut.r ** 2 - (e - keepOut.east) ** 2);
      const lo = keepOut.north - h;
      const hi = keepOut.north + h;
      segs = [[minN, Math.min(maxN, lo)], [Math.max(minN, hi), maxN]].filter(([a, b]) => b - a > 0.5) as Array<[number, number]>;
    }
    if (!up) segs = segs.map(([a, b]) => [b, a] as [number, number]).reverse();
    for (const [a, b] of segs) {
      for (const n of [a, b]) {
        const w = offset(lat0, lon0, n, e);
        if (insidePolygon(w.lat, w.lon, poly)) waypoints.push([w.lat, w.lon]);
      }
    }
    up = !up;
  }
  if (!waypoints.length) return { kind: 'failed', failure: 'no survey legs fit inside the geofence' };

  const registry = verify ? new ObjectRegistry() : ctx.objects;
  if (zone && !ctx.keepOut.some((k) => distanceM(k.lat, k.lon, zone.lat, zone.lon) < 0.5)) {
    ctx.keepOut.push({ lat: zone.lat, lon: zone.lon, r: zoneR + 0.7 });
  }
  let carried: TrackedObject | null = null;
  let mouthEmpty = 0;
  const avoided = new Set<string>();
  ctx.log('survey', { step: step.id, legs: waypoints.length / 2, spacing, mode: verify ? 'verify' : 'find' });
  for (const [i, [la, lo]] of waypoints.entries()) {
    const out = await driveTo(ctx, la, lo, {
      speed, radius: 1.0,
      onPoll: async (st, pose) => {
        const dets = await look(ctx, st, ['camera', 'ferret']);
        register(registry, pose, dets);
        // a ball in the plow mouth is being carried along: register it where it is, so a
        // scooped ball can't silently disappear from the count
        const inMouth = dets.find((d) => d.source === 'ferret' && d.forward_m < 0.45 && Math.abs(d.right_m) < 0.15);
        if (inMouth) {
          const w = bodyToLatLon(pose, inMouth.forward_m, inMouth.right_m);
          if (!carried) {
            carried = registry.add(w.lat, w.lon, 0.3);
            carried.sightings = Math.max(carried.sightings, 2);
            ctx.log('survey_scooped', { step: step.id, object: carried.id });
          } else {
            carried.lat = w.lat; // moves with the rover
            carried.lon = w.lon;
          }
          mouthEmpty = 0;
        } else if (carried && ++mouthEmpty > 3) {
          carried = null;
        }
        // don't drive over (and scoop up) a ball we know about, from this survey or an earlier
        // one: sidestep it, on a side that stays out of keep-out zones and inside the fence
        const known = verify ? [...registry.confirmed(), ...ctx.objects.confirmed()] : registry.confirmed();
        for (const ob of known) {
          const key = `${ob.id}@${ob.lat.toFixed(6)}`;
          if (avoided.has(key) || ob === carried) continue;
          const b = latLonToBody(pose, ob.lat, ob.lon);
          if (b.forward > 0.3 && b.forward < 1.5 && Math.abs(b.right) < 0.4) {
            avoided.add(key);
            const first = b.right >= 0 ? -1 : 1; // the far side first
            for (const side of [first, -first]) {
              const v = bodyToLatLon(pose, b.forward, b.right + side * 0.6);
              const clear = insidePolygon(v.lat, v.lon, poly) && ctx.keepOut.every((z) => distanceM(z.lat, z.lon, v.lat, v.lon) > z.r);
              if (clear) {
                ctx.log('sidestep', { step: step.id, object: ob.id });
                return { via: v };
              }
            }
          }
        }
      },
    });
    if (out.kind !== 'done') return out.kind === 'failed' ? { kind: 'failed', failure: `survey waypoint ${i + 1}/${waypoints.length}: ${out.failure}` } : out;
  }

  const found = registry.confirmed();
  if (zone) for (const o of found) if (distanceM(o.lat, o.lon, zone.lat, zone.lon) <= zoneR) o.status = 'delivered';
  const outside = found.filter((o) => o.status !== 'delivered');
  ctx.log('survey_result', { step: step.id, found: found.length, outside_target: outside.length, objects: found.map((o) => ({ id: o.id, lat: +o.lat.toFixed(7), lon: +o.lon.toFixed(7), sightings: o.sightings, status: o.status })) });
  if (verify && outside.length) {
    return { kind: 'failed', failure: `verify survey found ${outside.length} object(s) outside the target zone: ${outside.map((o) => `(${o.lat.toFixed(6)}, ${o.lon.toFixed(6)})`).join(', ')}` };
  }
  return { kind: 'done', detail: verify ? `no objects outside the target zone (${found.length} inside)` : `${found.length} object(s) found, ${outside.length} outside the target zone` };
}

/** Turn in place and look around. params: degrees (360), yaw_rate_rps (0.4). */
export async function holdAndLookBehaviour(ctx: Ctx, step: SpecStep): Promise<StepOutcome> {
  const degrees = num(step.params['degrees']) ?? 360;
  const yaw = num(step.params['yaw_rate_rps']) ?? 0.4;
  let remaining = rad(degrees) / yaw;
  const before = ctx.objects.objects.length;
  while (remaining > 0) {
    const st = await ctx.guard();
    const p = poseOf(st);
    if (p) register(ctx.objects, p, await look(ctx, st));
    const chunk = Math.min(0.5, remaining);
    const err = await nudge(ctx, 0, yaw, chunk);
    if (err) return { kind: 'failed', failure: `turn refused: ${err}` };
    remaining -= chunk;
  }
  return { kind: 'done', detail: `${ctx.objects.objects.length - before} new object(s)` };
}

/**
 * Drive up to the current object so it ends up in the plow mouth.
 * Far away: goto a stand-off point (behind the object as seen from align_to, if given).
 * Close: visual servoing on the camera, the Ferret for the last 0.7 m; without the Ferret the
 * last stretch inside the camera's blind zone is dead-reckoned.
 * params: align_to (target), speed_mps (0.15), capture_forward_m (0.3), lateral_tol_m (0.08)
 */
export async function approachBehaviour(ctx: Ctx, step: SpecStep): Promise<StepOutcome> {
  const obj = ctx.current;
  if (!obj) return { kind: 'failed', failure: 'approach has no object (use it inside a for_each block)' };
  const p = step.params;
  const speed = Math.min(num(p['speed_mps']) ?? 0.15, ctx.spec.limits.max_speed_mps);
  const capture = num(p['capture_forward_m']) ?? 0.3;
  const tol = num(p['lateral_tol_m']) ?? 0.08;
  const align = targetOf(p['align_to']);

  // stand-off
  const st0 = await ctx.guard();
  const p0 = poseOf(st0);
  if (!p0) return { kind: 'failed', failure: 'no position telemetry' };
  // too close to see (e.g. after it escaped from the plow): back up so the camera sees it again
  const close = latLonToBody(p0, obj.lat, obj.lon);
  if (Math.hypot(close.forward, close.right) < 0.7) {
    ctx.log('approach_backup', { step: step.id, object: obj.id });
    const err = await nudge(ctx, -0.2, 0, 3);
    if (err) return { kind: 'failed', failure: `approach refused: ${err}` };
  }
  if (distanceM(p0.lat, p0.lon, obj.lat, obj.lon) > 2.0) {
    const from = align ?? { lat: p0.lat, lon: p0.lon };
    const dn = (obj.lat - from.lat) * M_LAT * (align ? 1 : -1);
    const de = (obj.lon - from.lon) * mLon(obj.lat) * (align ? 1 : -1);
    const len = Math.hypot(dn, de) || 1;
    // stand-off 1.2 m from the object, inside the geofence with 0.5 m clearance; rotate the
    // approach direction around the object until it fits
    const fits = (q: { lat: number; lon: number }) => [0, 90, 180, 270].every((a) => {
      const c = offset(q.lat, q.lon, 0.5 * Math.cos(rad(a)), 0.5 * Math.sin(rad(a)));
      return insidePolygon(c.lat, c.lon, ctx.spec.geofence);
    });
    const base = Math.atan2(de / len, dn / len);
    let so: { lat: number; lon: number } | null = null;
    for (const da of [0, 20, -20, 40, -40, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
      const a = base + rad(da);
      const q = offset(obj.lat, obj.lon, 1.2 * Math.cos(a), 1.2 * Math.sin(a));
      if (fits(q)) { so = q; break; }
    }
    if (!so) return { kind: 'failed', failure: `no stand-off point for ${obj.id} inside the geofence` };
    ctx.log('approach_standoff', { step: step.id, object: obj.id, ...so });
    const out = await driveTo(ctx, so.lat, so.lon, { speed: ctx.spec.limits.max_speed_mps, radius: 0.8 });
    if (out.kind !== 'done') return out;
  }

  // close in
  const deadline = ctx.now() + 120_000;
  let unseen = 0;
  let seen = 0;
  let inViewUnseen = 0;
  let lastSource = '';
  while (ctx.now() < deadline) {
    const st = await ctx.guard();
    const pose = poseOf(st);
    if (!pose) { await ctx.sleep(ctx.pollMs); continue; }
    const pred = latLonToBody(pose, obj.lat, obj.lon);
    const dets = await look(ctx, st, ['ferret', 'camera']);
    const near = (d: Detection) => Math.hypot(d.forward_m - pred.forward, d.right_m - pred.right);
    // matching gate: wide while far (the map estimate may be off), tight up close
    // (the survey's estimate can be off by ~0.5 m, so the camera gate is at least 1 m)
    const gate = (d: Detection) => (d.source === 'ferret' ? 0.4 : Math.max(1.0, Math.min(1.5, 0.4 * Math.hypot(pred.forward, pred.right))));
    const pick = dets.filter((d) => near(d) < gate(d)).sort((a, b) => (a.source === b.source ? near(a) - near(b) : a.source === 'ferret' ? -1 : 1))[0];
    let fwd = pred.forward;
    let right = pred.right;
    if (pick) {
      unseen = 0;
      seen++;
      fwd = pick.forward_m;
      right = pick.right_m;
      lastSource = pick.source;
      const w = bodyToLatLon(pose, fwd, right);
      obj.lat = w.lat;
      obj.lon = w.lon;
      if (fwd <= capture && Math.abs(right) <= tol) {
        return { kind: 'done', detail: `${obj.id} in the plow mouth (${pick.source}: ${fwd.toFixed(2)} m ahead, ${right.toFixed(2)} m right)` };
      }
    } else {
      unseen++;
      // clearly in the camera's view and never seen during the approach: a false sighting
      const predBearing = deg(Math.atan2(pred.right, pred.forward));
      if (pred.forward > 0.8 && pred.forward < 4 && Math.abs(predBearing) < 15) inViewUnseen++;
      if (seen === 0 && inViewUnseen >= 8) {
        obj.status = 'skipped';
        return { kind: 'dismiss', reason: `nothing at ${obj.id}'s position although it is in view (${pred.forward.toFixed(1)} m ahead): a false sighting` };
      }
      // camera blind zone and no Ferret: dead-reckon the last stretch
      if (!ctx.ferretSeen && pred.forward < 0.7 && pred.forward > capture - 0.05 && Math.abs(right) < 0.15) {
        const dist = pred.forward - capture + 0.05;
        const err = await nudge(ctx, 0.1, 0, Math.max(0.3, dist / 0.1));
        if (err) return { kind: 'failed', failure: `approach refused: ${err}` };
        return { kind: 'done', detail: `${obj.id}: last ${dist.toFixed(2)} m dead-reckoned (camera only, no depth camera)` };
      }
      if (unseen > 30) {
        if (seen === 0) {
          // never seen during the approach: it was moved (e.g. scooped up while surveying) or
          // it was a false sighting; the verify survey checks the real outcome
          obj.status = 'skipped';
          return { kind: 'dismiss', reason: `${obj.id} not found where expected (moved or a false sighting)` };
        }
        return { kind: 'failed', failure: `lost sight of ${obj.id} (last seen by ${lastSource})` };
      }
    }
    const bearing = Math.atan2(right, fwd);
    const yaw = clamp(1.5 * bearing, 0.5);
    const forward = Math.abs(deg(bearing)) < 15 ? Math.min(speed, 0.5 * (fwd - capture) + 0.03) : 0;
    const err = await nudge(ctx, Math.max(0, forward), yaw, 0.3);
    if (err) return { kind: 'failed', failure: `approach refused: ${err}` };
  }
  return { kind: 'failed', failure: `approach to ${obj.id} timed out` };
}

/**
 * Push the current object (in the plow mouth) to a target.
 * params: target, speed_mps (0.2), radius_m (1.0), capture_forward_m (0.3)
 */
export async function pushToBehaviour(ctx: Ctx, step: SpecStep): Promise<StepOutcome> {
  const obj = ctx.current;
  if (!obj) return { kind: 'failed', failure: 'push_to has no object (use it inside a for_each block)' };
  const p = step.params;
  const target = targetOf(p['target'] ?? p['destination']);
  if (!target) return { kind: 'failed', failure: 'push_to has no target coordinates' };
  const speed = Math.min(num(p['speed_mps']) ?? 0.2, ctx.spec.limits.max_speed_mps);
  const radius = num(p['radius_m']) ?? 1.0;
  const capture = num(p['capture_forward_m']) ?? 0.3;
  if (!ctx.ferretSeen) ctx.log('push_unmonitored', { step: step.id, note: 'no depth camera: the ball in the plow is not checked while pushing' });

  const st0 = await ctx.guard();
  const p0 = poseOf(st0);
  if (!p0) return { kind: 'failed', failure: 'no position telemetry' };
  const deadline = ctx.now() + (distanceM(p0.lat, p0.lon, target.lat, target.lon) / speed * 3 + 30) * 1000;
  let missing = 0;
  while (ctx.now() < deadline) {
    const st = await ctx.guard();
    const pose = poseOf(st);
    if (!pose) { await ctx.sleep(ctx.pollMs); continue; }
    const ball = bodyToLatLon(pose, capture, 0);
    const d = distanceM(ball.lat, ball.lon, target.lat, target.lon);
    if (ctx.ferretSeen) {
      const dets = await look(ctx, st, ['ferret']);
      const inMouth = dets.some((x) => x.forward_m < capture + 0.12 && Math.abs(x.right_m) < 0.15);
      missing = inMouth ? 0 : missing + 1;
      if (missing >= 4) {
        obj.lat = ball.lat;
        obj.lon = ball.lon;
        return { kind: 'failed', failure: `${obj.id} escaped from the plow ${d.toFixed(1)} m before the target` };
      }
    }
    if (d <= radius) {
      await ctx.client.stop();
      obj.lat = ball.lat;
      obj.lon = ball.lon;
      obj.status = 'delivered';
      return { kind: 'done', detail: `${obj.id} delivered, ${d.toFixed(2)} m from the target` };
    }
    // turn gently with a ball in the U: a sharp turn throws it out
    const err = relBearing(pose, target.lat, target.lon);
    const yaw = clamp(1.0 * rad(err), 0.25);
    const forward = Math.abs(err) < 25 ? speed : 0.08;
    const e = await nudge(ctx, forward, yaw, 0.3);
    if (e) return { kind: 'failed', failure: `push refused: ${e}` };
  }
  return { kind: 'failed', failure: `push of ${obj.id} timed out` };
}

/** Reverse straight back. params: distance_m (1.0: clear of a pile before turning), speed_mps (0.2) */
export async function backOffBehaviour(ctx: Ctx, step: SpecStep): Promise<StepOutcome> {
  const dist = num(step.params['distance_m']) ?? 1.0;
  const speed = Math.min(num(step.params['speed_mps']) ?? 0.2, ctx.spec.limits.max_speed_mps);
  await ctx.guard();
  const err = await nudge(ctx, -speed, 0, dist / speed);
  if (err) return { kind: 'failed', failure: `back off refused: ${err}` };
  return { kind: 'done', detail: `reversed ${dist} m` };
}

export const BEHAVIOURS: Record<string, (ctx: Ctx, step: SpecStep) => Promise<StepOutcome>> = {
  goto: gotoBehaviour,
  velocity: velocityBehaviour,
  stop: (ctx) => stopBehaviour(ctx),
  survey: surveyBehaviour,
  hold_and_look: holdAndLookBehaviour,
  approach: approachBehaviour,
  push_to: pushToBehaviour,
  back_off: backOffBehaviour,
};
