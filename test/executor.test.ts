// Run: node --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAborts, runMission, type DecideFn, type MissionEvent } from '../src/executor/executor.ts';
import type { AgentClient, AgentStatus } from '../src/executor/client.ts';
import type { MissionSpec } from '../src/planning/spec.ts';

/** A rover on a simulated clock: drives straight at the goto target at the commanded speed. */
class FakeRover implements AgentClient {
  t = 0;
  lat = 51.5;
  lon = 7.5;
  speed = 0;
  heading = 0;
  target: { lat: number; lon: number; speed: number } | null = null;
  canDrive = true;
  stuck = false;
  stops = 0;
  /** canDrive schedule: [fromMs, toMs) windows where the operator has taken over */
  takeovers: Array<[number, number]> = [];
  drift: { dlat: number; dlon: number } | null = null;

  advance(ms: number) {
    for (let i = 0; i < ms / 100; i++) {
      this.t += 100;
      const drivable = this.drivable();
      if (this.drift && drivable) { this.lat += this.drift.dlat; this.lon += this.drift.dlon; }
      if (!this.target || this.stuck || !drivable) { this.speed = 0; continue; }
      const dn = (this.target.lat - this.lat) * 111_320;
      const de = (this.target.lon - this.lon) * 111_320 * Math.cos((this.lat * Math.PI) / 180);
      const d = Math.hypot(dn, de);
      const step = this.target.speed * 0.1;
      if (d <= step) { this.lat = this.target.lat; this.lon = this.target.lon; this.target = null; this.speed = 0; continue; }
      this.heading = ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360;
      this.lat += (dn / d) * step / 111_320;
      this.lon += (de / d) * step / (111_320 * Math.cos((this.lat * Math.PI) / 180));
      this.speed = this.target.speed;
    }
  }
  drivable() { return this.canDrive && !this.takeovers.some(([a, b]) => this.t >= a && this.t < b); }
  async status(): Promise<AgentStatus> {
    const ok = this.drivable();
    return { canDrive: ok, refusal: ok ? null : 'vehicle is not in Guided mode', telemetry: { lat: this.lat, lon: this.lon, heading: this.heading, groundspeed: this.speed, at: this.t }, behaviour: null };
  }
  async goto(lat: number, lon: number, speed = 1) { if (!this.drivable()) return { ok: false, error: 'vehicle is not in Guided mode' }; this.target = { lat, lon, speed }; return { ok: true }; }
  async velocity(_f: number, _y: number, seconds: number) { this.advance(seconds * 1000); return { ok: true, sent: seconds * 10, error: null }; }
  async stop() { this.stops++; this.target = null; this.drift = null; this.speed = 0; return { ok: true }; }
}

const at = (north: number, east: number) => ({ lat: 51.5 + north / 111_320, lon: 7.5 + east / (111_320 * Math.cos((51.5 * Math.PI) / 180)) });
const fence: Array<[number, number]> = [[51.4995, 7.4990], [51.4995, 7.5010], [51.5010, 7.5010], [51.5010, 7.4990]];

function spec(steps: MissionSpec['steps'], extra: Partial<MissionSpec> = {}): MissionSpec {
  return {
    spec_version: 1, mission: 't', title: 't', goal: 'g', compiled_at: '', plan_round: 1, plan_hash: 'h',
    limits: { max_speed_mps: 0.5, max_duration_min: 30 }, geofence: fence, no_go: [], targets: {},
    success: [{ id: 's1', criterion: 'reach', measured_by: 'gps' }], preflight: [], steps,
    aborts: [{ condition: 'leaving the geofence', action: 'HOLD' }, { condition: 'link lost', action: 'HOLD' }, { condition: 'person within 3 m', action: 'HOLD' }],
    ...extra,
  };
}
const gotoStep = (id: string, north: number, east: number, extra: Record<string, unknown> = {}) => ({
  id, name: `go ${id}`, behaviour: 'goto', params: { target: { target: id, ...at(north, east) }, ...extra }, exit: 'within 2 m', on_failure: 'HOLD, ask operator', serves: ['s1'],
});

function harness(rover: FakeRover, decide: DecideFn = async () => ({ action: 'hold', reason: 'test', by: 'policy' })) {
  const events: MissionEvent[] = [];
  return {
    events,
    opts: { client: rover, decide, log: (e: MissionEvent) => events.push(e), now: () => rover.t, sleep: async (ms: number) => rover.advance(ms), pollMs: 500, handoverTimeoutMs: 60_000, maxPauseMs: 120_000 },
  };
}

test('runs goto steps to completion and scores the criteria', async () => {
  const rover = new FakeRover();
  const h = harness(rover);
  const r = await runMission(spec([gotoStep('p1', 20, 0), gotoStep('p2', 20, 20), { id: 'p3', name: 'halt', behaviour: 'stop', params: {}, exit: '', on_failure: '', serves: [] }]), h.opts);
  assert.equal(r.status, 'completed', JSON.stringify(r));
  assert.deepEqual(r.steps.map((s) => s.outcome), ['done', 'done', 'done']);
  assert.deepEqual(r.criteria, [{ id: 's1', served_by: ['p1', 'p2'], all_steps_done: true }]);
  assert.ok(Math.abs(rover.speed) < 0.01);
  assert.deepEqual(r.unmonitored, ['person within 3 m']);
});

test('waits for the handover and gives up without one', async () => {
  const rover = new FakeRover();
  rover.canDrive = false;
  const h = harness(rover);
  const r = await runMission(spec([gotoStep('p1', 10, 0)]), h.opts);
  assert.equal(r.status, 'not_started');
  assert.match(r.reason!, /no handover: vehicle is not in Guided mode/);
});

test('pauses while the operator has the rover and restarts the step after the handback', async () => {
  const rover = new FakeRover();
  rover.takeovers = [[10_000, 25_000]];
  const h = harness(rover);
  const r = await runMission(spec([gotoStep('p1', 30, 0)]), h.opts);
  assert.equal(r.status, 'completed', JSON.stringify(r));
  const types = h.events.map((e) => e.type);
  assert.ok(types.includes('paused') && types.includes('resumed'));
  assert.equal(h.events.filter((e) => e.type === 'step_start').length, 2, JSON.stringify(h.events.map((e) => [e.t, e.type, e['why'] ?? e['detail'] ?? ''])));
  assert.equal(r.steps[0]!.attempts, 1);
});

test('aborts and stops when the rover leaves the geofence', async () => {
  const rover = new FakeRover();
  rover.drift = { dlat: 0, dlon: -0.00002 }; // pushed west, out of the fence
  const h = harness(rover);
  const r = await runMission(spec([gotoStep('p1', 50, 0, { timeout_s: 600 })]), h.opts);
  assert.equal(r.status, 'aborted');
  assert.match(r.reason!, /left the geofence/);
  assert.ok(rover.stops >= 1);
});

test('a failed step goes to the decider: retry, then skip', async () => {
  const rover = new FakeRover();
  rover.stuck = true;
  const answers = ['retry', 'skip'] as const;
  let asked = 0;
  const h = harness(rover, async (ctx) => {
    assert.match(ctx.failure, /did not arrive/);
    return { action: answers[asked++]!, reason: 'test', by: 'llm' };
  });
  const r = await runMission(spec([gotoStep('p1', 10, 0, { timeout_s: 5 }), { id: 'p2', name: 'halt', behaviour: 'stop', params: {}, exit: '', on_failure: '', serves: [] }]), h.opts);
  assert.equal(r.status, 'completed');
  assert.equal(asked, 2);
  assert.equal(r.steps[0]!.outcome, 'skipped');
  assert.equal(r.steps[0]!.attempts, 2);
  assert.deepEqual(r.criteria[0], { id: 's1', served_by: ['p1'], all_steps_done: false });
});

test('retries are capped, then the mission holds; unknown behaviours fail into a decision', async () => {
  const rover = new FakeRover();
  const h = harness(rover, async () => ({ action: 'retry', reason: 'again', by: 'llm' }));
  const r = await runMission(spec([{ id: 'p1', name: 'jump', behaviour: 'teleport', params: {}, exit: '', on_failure: '', serves: ['s1'] }]), { ...h.opts, maxRetries: 2 });
  assert.equal(r.status, 'held');
  assert.match(r.reason!, /not implemented in the executor/);
  assert.equal(r.steps[0]!.attempts, 3);
  const last = h.events.filter((e) => e.type === 'decision').at(-1)!;
  assert.equal(last['by'], 'policy');
});

test('classifies which abort conditions the executor can watch', () => {
  const c = classifyAborts(spec([], { aborts: [
    { condition: 'Link loss to the ground station', action: 'HOLD' },
    { condition: 'Rover leaves the geofence', action: 'HOLD' },
    { condition: 'Battery low', action: 'operator: RTL' },
    { condition: 'Mission exceeds 45 minutes', action: 'HOLD' },
  ] }));
  assert.equal(c.monitored.length, 3);
  assert.deepEqual(c.unmonitored, ['Battery low']);
});

test('a mission held and resumed is scored over all its runs', async () => {
  const { mergeRuns, scoreCriteria } = await import('../src/executor/executor.ts');
  const s = spec([
    { id: 'p1', name: 'a', behaviour: 'goto', params: {}, exit: 'x', on_failure: 'hold', serves: ['s1'] },
    { id: 'p2', name: 'b', behaviour: 'goto', params: {}, exit: 'x', on_failure: 'hold', serves: ['s1'] },
    { id: 'p3', name: 'c', behaviour: 'goto', params: {}, exit: 'x', on_failure: 'hold', serves: ['s1'] },
  ]);
  const run1 = [{ id: 'p1', outcome: 'done' as const, attempts: 1 }, { id: 'p2', outcome: 'failed' as const, attempts: 1 }];
  const run2 = [{ id: 'p2', outcome: 'done' as const, attempts: 1 }, { id: 'p3', outcome: 'done' as const, attempts: 1 }];
  assert.equal(scoreCriteria(s, run2)[0]!.all_steps_done, false); // p1 isn't in the resumed run
  const merged = mergeRuns([run1, run2]);
  assert.deepEqual(merged.map((r) => `${r.id}:${r.outcome}`), ['p1:done', 'p2:done', 'p3:done']);
  assert.equal(scoreCriteria(s, merged)[0]!.all_steps_done, true);
});
