// Mission executor: runs a compiled mission spec as a deterministic state machine.
//
// * Each step runs its behaviour with built-in completion and a timeout (goto: within the arrival
//   radius and stopped; velocity: after its duration; stop: at once).
// * Monitors run on every poll: geofence, mission time, overspeed, stale telemetry.
// * The operator owns the handover: the run starts when the rover is armed and in Guided and
//   pauses whenever it isn't (the module's gate refuses then anyway); the interrupted step
//   restarts when the operator hands back.
// * The LLM is only asked at decision points (a step failed): retry, skip, hold for the
//   operator, or abort. Without an answer the executor holds.
// The executor never arms, disarms or changes modes; "stop" means zero velocity in Guided.

import type { MissionSpec, SpecStep } from '../planning/spec.ts';
import type { AgentClient, AgentStatus } from './client.ts';
import { distanceM, insidePolygon } from './geo.ts';

export type DecisionAction = 'retry' | 'skip' | 'hold' | 'abort';
export interface Decision { action: DecisionAction; reason: string; by: 'llm' | 'policy' }
export interface DecisionContext {
  spec: MissionSpec;
  step: SpecStep;
  attempt: number;
  maxRetries: number;
  failure: string;
  status: AgentStatus | null;
}
export type DecideFn = (ctx: DecisionContext) => Promise<Decision>;

export interface MissionEvent { t: number; type: string; [k: string]: unknown }

export interface RunOptions {
  client: AgentClient;
  decide: DecideFn;
  log?: (e: MissionEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Start at this step id (resume after a hold). */
  fromStep?: string;
  /** How long to wait for the operator to hand over (armed + Guided). */
  handoverTimeoutMs?: number;
  /** How long a pause (operator took over, link gone) may last before the run is aborted. */
  maxPauseMs?: number;
  maxRetries?: number;
  staleMs?: number;
}

export interface StepResult { id: string; outcome: 'done' | 'skipped' | 'failed'; attempts: number; detail?: string }
export interface RunResult {
  status: 'completed' | 'aborted' | 'held' | 'not_started';
  reason?: string;
  steps: StepResult[];
  criteria: Array<{ id: string; served_by: string[]; all_steps_done: boolean }>;
  monitored: string[];
  unmonitored: string[];
  started_at: number;
  ended_at: number;
}

type StepOutcome =
  | { kind: 'done'; detail?: string }
  | { kind: 'failed'; failure: string }
  | { kind: 'restart' } // paused and handed back: run the step again, not counted as an attempt
  | { kind: 'abort'; reason: string };

class Abort extends Error {}
class Restart extends Error {}

/** Which of the spec's abort conditions the executor watches itself, and which it can't. */
export function classifyAborts(spec: MissionSpec): { monitored: string[]; unmonitored: string[] } {
  const monitored: string[] = [];
  const unmonitored: string[] = [];
  for (const a of spec.aborts) {
    const c = `${a.condition} ${a.action}`;
    if (/fence|boundary|leav(e|ing) the (lawn|area)/i.test(c)) monitored.push(`${a.condition} (geofence check every poll)`);
    else if (/link|connection|gcs|heartbeat|telemetry/i.test(c)) monitored.push(`${a.condition} (executor pauses on stale telemetry; the vehicle's GCS failsafe holds)`);
    else if (/time|duration|minutes/i.test(c)) monitored.push(`${a.condition} (mission time limit)`);
    else if (/speed/i.test(c)) monitored.push(`${a.condition} (overspeed check)`);
    else unmonitored.push(a.condition);
  }
  return { monitored, unmonitored };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export async function runMission(spec: MissionSpec, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 500;
  const maxRetries = opts.maxRetries ?? 2;
  const staleMs = opts.staleMs ?? 3000;
  const maxPauseMs = opts.maxPauseMs ?? 10 * 60_000;
  const { client } = opts;
  const log = (type: string, data: Record<string, unknown> = {}) => opts.log?.({ t: now(), type, ...data });

  const started = now();
  const limitMs = spec.limits.max_duration_min ? spec.limits.max_duration_min * 60_000 : null;
  const { monitored, unmonitored } = classifyAborts(spec);
  const results: StepResult[] = [];
  let lastStatus: AgentStatus | null = null;

  const finish = (status: RunResult['status'], reason?: string): RunResult => {
    const criteria = spec.success.map((c) => {
      const served = spec.steps.filter((s) => s.serves.includes(c.id)).map((s) => s.id);
      const all = served.length > 0 && served.every((id) => results.find((r) => r.id === id)?.outcome === 'done');
      return { id: c.id, served_by: served, all_steps_done: all };
    });
    const r: RunResult = { status, ...(reason ? { reason } : {}), steps: results, criteria, monitored, unmonitored, started_at: started, ended_at: now() };
    log('end', { status, reason, criteria });
    return r;
  };

  const stopRover = async (why: string) => {
    try { await client.stop(); } catch { /* the module may be unreachable; the vehicle failsafe holds */ }
    log('stop', { why });
  };

  log('start', { mission: spec.mission, plan_hash: spec.plan_hash, steps: spec.steps.map((s) => s.id), monitored, unmonitored });

  // --- handover --------------------------------------------------------------------------
  const handoverDeadline = now() + (opts.handoverTimeoutMs ?? 10 * 60_000);
  log('waiting_for_handover', { hint: 'operator: arm and switch to GUIDED' });
  for (;;) {
    try { lastStatus = await client.status(); } catch (err) { lastStatus = null; log('status_error', { error: (err as Error).message }); }
    if (lastStatus?.canDrive) break;
    if (now() > handoverDeadline) return finish('not_started', `no handover: ${lastStatus?.refusal ?? 'module unreachable'}`);
    await sleep(pollMs);
  }
  log('handover', {});

  /**
   * One poll: read status, run the monitors. Throws Abort for mission-ending conditions and
   * Restart after a pause the operator ended by handing back.
   */
  let overspeedPolls = 0;
  const guard = async (): Promise<AgentStatus> => {
    let st: AgentStatus | null = null;
    try { st = await client.status(); } catch (err) { log('status_error', { error: (err as Error).message }); }
    lastStatus = st;
    if (limitMs !== null && now() - started > limitMs) throw new Abort(`mission time limit of ${spec.limits.max_duration_min} min reached`);
    const stale = !st || st.telemetry.at === undefined || now() - st.telemetry.at > staleMs;
    if (!st || !st.canDrive || stale) {
      const why = !st ? 'module unreachable' : !st.canDrive ? st.refusal ?? 'not drivable' : 'telemetry stale';
      log('paused', { why });
      const pausedAt = now();
      for (;;) {
        await sleep(pollMs);
        try { st = await client.status(); } catch { st = null; }
        if (limitMs !== null && now() - started > limitMs) throw new Abort(`mission time limit of ${spec.limits.max_duration_min} min reached while paused`);
        if (now() - pausedAt > maxPauseMs) throw new Abort(`paused longer than ${maxPauseMs / 60_000} min (${why})`);
        if (st?.canDrive && st.telemetry.at !== undefined && now() - st.telemetry.at <= staleMs) break;
      }
      log('resumed', { paused_s: Math.round((now() - pausedAt) / 1000) });
      throw new Restart();
    }
    const { lat, lon, groundspeed } = st.telemetry;
    if (lat !== undefined && lon !== undefined && spec.geofence.length >= 3 && !insidePolygon(lat, lon, spec.geofence)) {
      throw new Abort(`left the geofence at (${lat.toFixed(6)}, ${lon.toFixed(6)})`);
    }
    if (groundspeed !== undefined && groundspeed > spec.limits.max_speed_mps * 1.5 + 0.2) {
      if (++overspeedPolls >= 2) throw new Abort(`overspeed: ${groundspeed.toFixed(2)} m/s, limit ${spec.limits.max_speed_mps} m/s`);
    } else {
      overspeedPolls = 0;
    }
    return st;
  };

  // --- behaviours ------------------------------------------------------------------------
  const runGoto = async (step: SpecStep): Promise<StepOutcome> => {
    const p = step.params;
    const t = (p['target'] ?? p['destination'] ?? p['waypoint']) as { lat?: number; lon?: number } | undefined;
    const lat = num(t?.lat) ?? num(p['lat']);
    const lon = num(t?.lon) ?? num(p['lon']);
    if (lat === undefined || lon === undefined) return { kind: 'failed', failure: 'goto has no target coordinates' };
    const speed = Math.min(num(p['max_speed_mps']) ?? num(p['speed_mps']) ?? spec.limits.max_speed_mps, spec.limits.max_speed_mps);
    const radius = num(p['arrival_radius_m']) ?? 2.0;
    const st0 = await guard();
    const d0 = st0.telemetry.lat !== undefined ? distanceM(st0.telemetry.lat, st0.telemetry.lon!, lat, lon) : 0;
    const timeoutMs = (num(p['timeout_s']) ?? d0 / speed * 2.5 + 20) * 1000;
    const r = await client.goto(lat, lon, speed);
    if (r.ok === false) return { kind: 'failed', failure: `goto refused: ${r.error ?? 'unknown'}` };
    log('goto', { step: step.id, lat, lon, speed, radius, distance_m: Math.round(d0 * 10) / 10 });
    const deadline = now() + timeoutMs;
    for (;;) {
      await sleep(pollMs);
      const st = await guard();
      const { lat: la, lon: lo, groundspeed } = st.telemetry;
      if (la !== undefined && lo !== undefined) {
        const d = distanceM(la, lo, lat, lon);
        if (d <= radius && (groundspeed ?? 0) < 0.3) return { kind: 'done', detail: `arrived, ${d.toFixed(1)} m from target` };
        if (now() > deadline) return { kind: 'failed', failure: `did not arrive within ${Math.round(timeoutMs / 1000)} s, ${d.toFixed(1)} m left` };
      } else if (now() > deadline) {
        return { kind: 'failed', failure: 'no position telemetry' };
      }
    }
  };

  const runVelocity = async (step: SpecStep): Promise<StepOutcome> => {
    const p = step.params;
    const limit = spec.limits.max_speed_mps;
    const forward = Math.max(-limit, Math.min(limit, num(p['forward_mps']) ?? num(p['forward']) ?? 0));
    const yaw = num(p['yaw_rate_rps']) ?? num(p['yawRate']) ?? 0;
    const seconds = num(p['seconds']) ?? num(p['duration_s']);
    if (seconds === undefined || seconds <= 0) return { kind: 'failed', failure: 'velocity has no duration' };
    let remaining = seconds;
    while (remaining > 0) {
      await guard();
      const chunk = Math.min(1, remaining);
      const r = await client.velocity(forward, yaw, chunk);
      if (r.error) return { kind: 'failed', failure: `velocity refused: ${r.error}` };
      remaining -= chunk;
    }
    return { kind: 'done', detail: `${seconds} s at ${forward} m/s, ${yaw} rad/s` };
  };

  const runStep = async (step: SpecStep): Promise<StepOutcome> => {
    try {
      switch (step.behaviour) {
        case 'goto': return await runGoto(step);
        case 'velocity': return await runVelocity(step);
        case 'stop': await guard(); await client.stop(); return { kind: 'done' };
        default: return { kind: 'failed', failure: `behaviour "${step.behaviour}" is not implemented in the executor` };
      }
    } catch (err) {
      if (err instanceof Restart) return { kind: 'restart' };
      if (err instanceof Abort) return { kind: 'abort', reason: err.message };
      return { kind: 'failed', failure: (err as Error).message };
    }
  };

  // --- steps -----------------------------------------------------------------------------
  let start = 0;
  if (opts.fromStep) {
    start = spec.steps.findIndex((s) => s.id === opts.fromStep);
    if (start < 0) return finish('not_started', `no step "${opts.fromStep}"`);
  }

  for (const step of spec.steps.slice(start)) {
    let attempt = 1;
    let restarts = 0;
    for (;;) {
      log('step_start', { step: step.id, name: step.name, behaviour: step.behaviour, attempt });
      const out = await runStep(step);
      if (out.kind === 'done') {
        results.push({ id: step.id, outcome: 'done', attempts: attempt, ...(out.detail ? { detail: out.detail } : {}) });
        log('step_done', { step: step.id, detail: out.detail });
        break;
      }
      if (out.kind === 'abort') {
        await stopRover(out.reason);
        results.push({ id: step.id, outcome: 'failed', attempts: attempt, detail: out.reason });
        return finish('aborted', out.reason);
      }
      if (out.kind === 'restart') {
        if (++restarts > 20) { await stopRover('too many restarts'); return finish('aborted', `step ${step.id} restarted too often`); }
        continue;
      }
      // failed: stop the rover, then ask
      await stopRover(`step ${step.id} failed`);
      log('step_failed', { step: step.id, attempt, failure: out.failure });
      let decision: Decision;
      try {
        decision = await opts.decide({ spec, step, attempt, maxRetries, failure: out.failure, status: lastStatus });
      } catch (err) {
        decision = { action: 'hold', reason: `no decision (${(err as Error).message})`, by: 'policy' };
      }
      if (decision.action === 'retry' && attempt > maxRetries) {
        decision = { action: 'hold', reason: `retry refused: ${maxRetries} retries used (${decision.reason})`, by: 'policy' };
      }
      log('decision', { step: step.id, ...decision });
      if (decision.action === 'retry') { attempt++; continue; }
      if (decision.action === 'skip') {
        results.push({ id: step.id, outcome: 'skipped', attempts: attempt, detail: `${out.failure}; skipped: ${decision.reason}` });
        break;
      }
      results.push({ id: step.id, outcome: 'failed', attempts: attempt, detail: out.failure });
      return finish(decision.action === 'abort' ? 'aborted' : 'held', `${step.id}: ${out.failure} (${decision.reason})`);
    }
  }
  return finish('completed');
}
