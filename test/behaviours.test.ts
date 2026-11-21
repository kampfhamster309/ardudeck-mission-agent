// Run: node --test test/*.test.ts
// Offline: a kinematic rover + the simulated world (sim/world.ts) on a simulated clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMission, type DecideFn, type MissionEvent } from '../src/executor/executor.ts';
import type { AgentClient, AgentStatus } from '../src/executor/client.ts';
import type { PerceptionClient } from '../src/executor/perception.ts';
import type { MissionSpec } from '../src/planning/spec.ts';
import { DEFAULT_CONFIG, World, type WorldConfig } from '../sim/world.ts';

const O = { lat: 51.5, lon: 7.5 };
const mLon = 111_320 * Math.cos((O.lat * Math.PI) / 180);
const ll = (east: number, north: number) => ({ lat: O.lat + north / 111_320, lon: O.lon + east / mLon });
const local = (lat: number, lon: number) => ({ east: (lon - O.lon) * mLon, north: (lat - O.lat) * 111_320 });

/** Skid-steer kinematics: goto drives (turn, then go) at the given speed; velocity integrates. */
class SimRover implements AgentClient, PerceptionClient {
  t = 0;
  east = 0;
  north = 0;
  heading = 0; // deg
  speed = 0;
  goal: { east: number; north: number; speed: number } | null = null;
  world: World;
  constructor(world: World) { this.world = world; }

  private tick(forward: number, yawRate: number, dt: number) {
    this.heading = (this.heading + (yawRate * 180) / Math.PI * dt + 360) % 360;
    const h = (this.heading * Math.PI) / 180;
    this.east += forward * Math.sin(h) * dt;
    this.north += forward * Math.cos(h) * dt;
    this.speed = Math.abs(forward);
    this.world.step({ east: this.east, north: this.north, heading_deg: this.heading, speed: forward });
    this.t += dt * 1000;
  }
  advance(ms: number) {
    for (let i = 0; i < ms / 100; i++) {
      if (!this.goal) { this.tick(0, 0, 0.1); continue; }
      const de = this.goal.east - this.east;
      const dn = this.goal.north - this.north;
      const d = Math.hypot(de, dn);
      if (d < 0.2) { this.goal = null; this.tick(0, 0, 0.1); continue; }
      const err = ((((Math.atan2(de, dn) * 180) / Math.PI - this.heading) + 540) % 360) - 180;
      const yaw = Math.max(-1, Math.min(1, (err * Math.PI) / 180 * 2));
      this.tick(Math.abs(err) < 30 ? Math.min(this.goal.speed, d) : 0, yaw, 0.1);
    }
  }
  async status(): Promise<AgentStatus> {
    const p = ll(this.east, this.north);
    return { canDrive: true, refusal: null, telemetry: { ...p, heading: Math.round(this.heading) % 360, groundspeed: this.speed, at: this.t }, behaviour: null };
  }
  async goto(lat: number, lon: number, speed = 1) { this.goal = { ...local(lat, lon), speed }; return { ok: true }; }
  async velocity(forward: number, yawRate: number, seconds: number) {
    this.goal = null;
    for (let i = 0; i < Math.round(seconds * 10); i++) this.tick(forward, yawRate, 0.1);
    return { ok: true, error: null };
  }
  async stop() { this.goal = null; this.speed = 0; return { ok: true }; }
  async detections() {
    return this.world.detections({ east: this.east, north: this.north, heading_deg: Math.round(this.heading) % 360, speed: this.speed });
  }
}

const corner = ll(9, 9);
function ballSpec(): MissionSpec {
  const fence: Array<[number, number]> = [[-2, -2], [-2, 12], [12, 12], [12, -2]].map(([e, n]) => { const p = ll(e!, n!); return [p.lat, p.lon]; });
  const t = { target: 'corner', ...corner };
  return {
    spec_version: 1, mission: 'balls', title: 'balls', goal: 'g', compiled_at: '', plan_round: 1, plan_hash: 'h',
    limits: { max_speed_mps: 0.5, max_duration_min: 60 }, geofence: fence, no_go: [], targets: { corner },
    success: [{ id: 's1', criterion: 'all balls in the corner', measured_by: 'verify survey' }],
    preflight: [], aborts: [{ condition: 'leaving the geofence', action: 'HOLD' }],
    steps: [
      { id: 'p1', name: 'find', behaviour: 'survey', params: { spacing_m: 2, margin_m: 1, target: t, radius_m: 1.2 }, exit: 'done', on_failure: 'hold', serves: [] },
      { id: 'p2', name: 'approach', behaviour: 'approach', params: { for_each: 'object', block: 'b1', align_to: t }, exit: 'in mouth', on_failure: 'retry', serves: ['s1'] },
      { id: 'p3', name: 'push', behaviour: 'push_to', params: { for_each: 'object', block: 'b1', target: t, radius_m: 1.1 }, exit: 'delivered', on_failure: 'retry', serves: ['s1'] },
      { id: 'p4', name: 'back off', behaviour: 'back_off', params: { for_each: 'object', block: 'b1', distance_m: 1.0 }, exit: 'done', on_failure: 'skip', serves: [] },
      { id: 'p5', name: 'verify', behaviour: 'survey', params: { spacing_m: 2, margin_m: 1, mode: 'verify', target: t, radius_m: 1.5 }, exit: 'none outside', on_failure: 'hold', serves: ['s1'] },
    ],
  };
}

function run(world: World, decide: DecideFn = async () => ({ action: 'retry', reason: 'test', by: 'policy' })) {
  const rover = new SimRover(world);
  const events: MissionEvent[] = [];
  const result = runMission(ballSpec(), {
    client: rover, perception: rover, decide,
    log: (e) => events.push(e), now: () => rover.t, sleep: async (ms) => rover.advance(ms), pollMs: 300,
  });
  return { rover, events, result };
}

const balls = [
  { id: 'b1', east: 3, north: 6, r: 0.03 },
  { id: 'b2', east: 7, north: 2, r: 0.03 },
];

test('survey finds the balls, the block pushes each into the corner, verify passes', async () => {
  const world = new World(balls, { ...DEFAULT_CONFIG, seed: 3 });
  const { result, events } = run(world);
  const r = await result;
  const trace = events.filter((e) => /step_|decision|survey_result|object_|detour/.test(e.type)).map((e) => `${(e.t / 1000).toFixed(0)}s ${e.type} ${e['step'] ?? ''} ${e['detail'] ?? e['failure'] ?? e['reason'] ?? e['object'] ?? e['found'] ?? ''}`).join('\n');
  assert.equal(r.status, 'completed', trace);
  for (const b of world.balls) {
    const d = Math.hypot(b.east - 9, b.north - 9);
    assert.ok(d < 1.6, `${b.id} is ${d.toFixed(2)} m from the corner\n${trace}`);
  }
  assert.equal(r.objects.filter((o) => o.status === 'delivered').length >= 2, true, trace);
  assert.deepEqual(r.criteria, [{ id: 's1', served_by: ['p2', 'p3', 'p5'], all_steps_done: true }]);
});

test('without the Ferret the last stretch is dead-reckoned and the push is not monitored', async () => {
  const cfg: WorldConfig = { ...DEFAULT_CONFIG, seed: 3, ferret: { ...DEFAULT_CONFIG.ferret, enabled: false } };
  const world = new World([balls[0]!], cfg);
  const { result, events } = run(world);
  const r = await result;
  const trace = events.filter((e) => /step_done|step_failed|decision|push_unmonitored/.test(e.type)).map((e) => `${e.type} ${e['step'] ?? ''} ${e['detail'] ?? e['failure'] ?? ''}`).join('\n');
  assert.ok(events.some((e) => e.type === 'step_done' && /dead-reckoned/.test(String(e['detail']))), trace);
  assert.ok(events.some((e) => e.type === 'push_unmonitored'), trace);
  assert.equal(r.status, 'completed', trace);
});

test('without a plow the ball escapes, the push fails into a decision', async () => {
  const cfg: WorldConfig = { ...DEFAULT_CONFIG, seed: 3, plow: { ...DEFAULT_CONFIG.plow, fitted: false } };
  const world = new World([balls[0]!], cfg);
  const failures: string[] = [];
  const { result } = run(world, async (ctx) => { failures.push(ctx.failure); return { action: 'hold', reason: 'test', by: 'policy' }; });
  const r = await result;
  assert.equal(r.status, 'held');
  assert.ok(failures.some((f) => /escaped from the plow|lost sight/.test(f)), failures.join('\n'));
});

test('detour: a line through a keep-out circle gets a waypoint beside it, others none', async () => {
  const { detour } = await import('../src/executor/behaviours.ts');
  const z = [{ ...ll(5, 5), r: 2 }];
  const via = detour(ll(0, 5), ll(10, 5), z);
  assert.ok(via);
  const v = local(via.lat, via.lon);
  assert.ok(Math.hypot(v.east - 5, v.north - 5) >= 2.39, JSON.stringify(v));
  assert.equal(detour(ll(0, 0), ll(10, 0), z), null); // passes 5 m away
  assert.equal(detour(ll(5, 5.5), ll(10, 5), z), null); // starts inside: that's a push into the zone
});
