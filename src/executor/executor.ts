// Mission executor: runs a compiled mission spec as a deterministic state machine.
//
// * Each step runs its behaviour (behaviours.ts) with built-in completion and a timeout.
// * Monitors run on every poll: geofence, mission time, overspeed, stale telemetry.
// * The operator owns the handover: the run starts when the rover is armed and in Guided and
//   pauses whenever it isn't (the module's gate refuses then anyway); the interrupted step
//   restarts when the operator hands back.
// * Blocks: consecutive steps with `params.for_each: "object"` and the same `params.block` run
//   once per found object (nearest first), e.g. approach -> push_to -> back_off per ball.
// * The LLM is only asked at decision points (a step failed): retry, skip, hold for the
//   operator, or abort. Without an answer the executor holds. Inside a block, retry restarts
//   the block for the same object and skip gives up on that object.
// The executor never arms, disarms or changes modes; "stop" means zero velocity in Guided.

import type { MissionSpec, SpecStep } from '../planning/spec.ts';
import type { AgentClient, AgentStatus } from './client.ts';
import { insidePolygon, distanceM } from './geo.ts';
import { blindPerception, type PerceptionClient } from './perception.ts';
import { Abort, BEHAVIOURS, ObjectRegistry, Restart, type Ctx, type StepOutcome, type TrackedObject } from './behaviours.ts';

export type DecisionAction = 'retry' | 'skip' | 'hold' | 'abort';
export interface Decision { action: DecisionAction; reason: string; by: 'llm' | 'policy' }
export interface DecisionContext {
  spec: MissionSpec;
  step: SpecStep;
  attempt: number;
  maxRetries: number;
  failure: string;
  status: AgentStatus | null;
  /** The object a for_each block was working on. */
  object?: { id: string; lat: number; lon: number } | null;
}
export type DecideFn = (ctx: DecisionContext) => Promise<Decision>;

export interface MissionEvent { t: number; type: string; [k: string]: unknown }

export interface RunOptions {
  client: AgentClient;
  decide: DecideFn;
  perception?: PerceptionClient;
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

export interface StepResult { id: string; object?: string; outcome: 'done' | 'skipped' | 'failed'; attempts: number; detail?: string }
export interface RunResult {
  status: 'completed' | 'aborted' | 'held' | 'not_started';
  reason?: string;
  steps: StepResult[];
  objects: TrackedObject[];
  criteria: Array<{ id: string; served_by: string[]; all_steps_done: boolean }>;
  monitored: string[];
  unmonitored: string[];
  started_at: number;
  ended_at: number;
}

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
  const objects = new ObjectRegistry();

  const finish = (status: RunResult['status'], reason?: string): RunResult => {
    const criteria = spec.success.map((c) => {
      const served = spec.steps.filter((s) => s.serves.includes(c.id)).map((s) => s.id);
      // every serving step must have run, and every run of it (one per object) must be done
      const all = served.length > 0 && served.every((id) => {
        // runs on dismissed objects (false sightings) don't count
        const dismissed = new Set(results.filter((r) => r.outcome === 'skipped' && /false sighting|not found where expected/.test(r.detail ?? '')).map((r) => r.object));
        const runs = results.filter((r) => r.id === id && !(r.object && dismissed.has(r.object)));
        return runs.length > 0 && runs.every((r) => r.outcome === 'done');
      });
      return { id: c.id, served_by: served, all_steps_done: all };
    });
    const r: RunResult = { status, ...(reason ? { reason } : {}), steps: results, objects: objects.objects, criteria, monitored, unmonitored, started_at: started, ended_at: now() };
    log('end', { status, ...(reason ? { reason } : {}), criteria });
    return r;
  };

  const stopRover = async (why: string) => {
    try { await client.stop(); } catch { /* the module may be unreachable; the vehicle failsafe holds */ }
    log('stop', { why });
  };

  log('start', { mission: spec.mission, plan_hash: spec.plan_hash, steps: spec.steps.map((s) => s.id), monitored, unmonitored });

  // --- handover ----------------------------------------------------------------------------
  const handoverDeadline = now() + (opts.handoverTimeoutMs ?? 10 * 60_000);
  log('waiting_for_handover', { hint: 'operator: arm and switch to GUIDED' });
  for (;;) {
    try { lastStatus = await client.status(); } catch (err) { lastStatus = null; log('status_error', { error: (err as Error).message }); }
    if (lastStatus?.canDrive) break;
    if (now() > handoverDeadline) return finish('not_started', `no handover: ${lastStatus?.refusal ?? 'module unreachable'}`);
    await sleep(pollMs);
  }
  log('handover', {});

  // --- monitors ----------------------------------------------------------------------------
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

  const ctx: Ctx = {
    spec, client, perception: opts.perception ?? blindPerception, objects, current: null, ferretSeen: false, keepOut: [],
    guard, log, now, sleep, pollMs,
  };

  const runStep = async (step: SpecStep): Promise<StepOutcome> => {
    const behaviour = BEHAVIOURS[step.behaviour];
    if (!behaviour) return { kind: 'failed', failure: `behaviour "${step.behaviour}" is not implemented in the executor` };
    try {
      return await behaviour(ctx, step);
    } catch (err) {
      if (err instanceof Restart) return { kind: 'restart' };
      if (err instanceof Abort) return { kind: 'abort', reason: err.message };
      return { kind: 'failed', failure: (err as Error).message };
    }
  };

  /**
   * Run one step until done, with pause restarts and decisions on failure.
   * 'next' = carry on; 'retry_block' = start the enclosing block again; 'skip_object';
   * or a final run status.
   */
  type Flow = { flow: 'next' } | { flow: 'retry_block' } | { flow: 'skip_object' } | { flow: 'dismiss_object' } | { flow: 'end'; status: RunResult['status']; reason: string };
  const attempts = new Map<string, number>();
  const execute = async (step: SpecStep, inBlock: boolean): Promise<Flow> => {
    const key = `${step.id}#${ctx.current?.id ?? ''}`;
    let restarts = 0;
    for (;;) {
      const attempt = attempts.get(key) ?? 1;
      log('step_start', { step: step.id, name: step.name, behaviour: step.behaviour, attempt, ...(ctx.current ? { object: ctx.current.id } : {}) });
      const out = await runStep(step);
      const base = { id: step.id, ...(ctx.current ? { object: ctx.current.id } : {}), attempts: attempt };
      if (out.kind === 'done') {
        results.push({ ...base, outcome: 'done', ...(out.detail ? { detail: out.detail } : {}) });
        log('step_done', { step: step.id, ...(out.detail ? { detail: out.detail } : {}) });
        return { flow: 'next' };
      }
      if (out.kind === 'dismiss') {
        results.push({ ...base, outcome: 'skipped', detail: out.reason });
        log('object_dismissed', { step: step.id, reason: out.reason });
        if (inBlock) return { flow: 'dismiss_object' };
        return { flow: 'next' };
      }
      if (out.kind === 'abort') {
        await stopRover(out.reason);
        results.push({ ...base, outcome: 'failed', detail: out.reason });
        return { flow: 'end', status: 'aborted', reason: out.reason };
      }
      if (out.kind === 'restart') {
        if (++restarts > 20) { await stopRover('too many restarts'); return { flow: 'end', status: 'aborted', reason: `step ${step.id} restarted too often` }; }
        continue;
      }
      await stopRover(`step ${step.id} failed`);
      log('step_failed', { step: step.id, attempt, failure: out.failure });
      let decision: Decision;
      try {
        decision = await opts.decide({ spec, step, attempt, maxRetries, failure: out.failure, status: lastStatus, object: ctx.current });
      } catch (err) {
        decision = { action: 'hold', reason: `no decision (${(err as Error).message})`, by: 'policy' };
      }
      if (decision.action === 'retry' && attempt > maxRetries) {
        decision = { action: 'hold', reason: `retry refused: ${maxRetries} retries used (${decision.reason})`, by: 'policy' };
      }
      log('decision', { step: step.id, ...decision });
      if (decision.action === 'retry') {
        attempts.set(key, attempt + 1);
        if (inBlock) return { flow: 'retry_block' };
        continue;
      }
      if (decision.action === 'skip') {
        results.push({ ...base, outcome: 'skipped', detail: `${out.failure}; skipped: ${decision.reason}` });
        return inBlock ? { flow: 'skip_object' } : { flow: 'next' };
      }
      results.push({ ...base, outcome: 'failed', detail: out.failure });
      return { flow: 'end', status: decision.action === 'abort' ? 'aborted' : 'held', reason: `${step.id}: ${out.failure} (${decision.reason})` };
    }
  };

  // --- steps ---------------------------------------------------------------------------------
  let i = 0;
  if (opts.fromStep) {
    i = spec.steps.findIndex((s) => s.id === opts.fromStep);
    if (i < 0) return finish('not_started', `no step "${opts.fromStep}"`);
  }
  while (i < spec.steps.length) {
    const step = spec.steps[i]!;
    if (step.params['for_each'] !== 'object') {
      const f = await execute(step, false);
      if (f.flow === 'end') return finish(f.status, f.reason);
      i++;
      continue;
    }

    // a block: this step and the following ones with the same block id, once per object
    const blockId = step.params['block'] ?? step.id;
    let j = i;
    while (j < spec.steps.length && (spec.steps[j]!.params['block'] ?? spec.steps[j]!.id) === blockId) j++;
    const block = spec.steps.slice(i, j);
    log('block_start', { block: blockId, steps: block.map((s) => s.id), objects: objects.confirmed().filter((o) => o.status === 'found').length });
    const tried = new Set<string>();
    for (;;) {
      const st = lastStatus?.telemetry;
      const todo = objects.confirmed().filter((o) => o.status === 'found' && !tried.has(o.id));
      if (!todo.length) break;
      // nearest first
      if (st?.lat !== undefined && st.lon !== undefined) todo.sort((a, b) => distanceM(st.lat!, st.lon!, a.lat, a.lon) - distanceM(st.lat!, st.lon!, b.lat, b.lon));
      const obj = todo[0]!;
      ctx.current = obj;
      log('object_start', { object: obj.id, lat: obj.lat, lon: obj.lon });
      let k = 0;
      while (k < block.length) {
        const f = await execute(block[k]!, true);
        if (f.flow === 'end') { ctx.current = null; return finish(f.status, f.reason); }
        if (f.flow === 'retry_block') { k = 0; continue; }
        if (f.flow === 'skip_object') { if (obj.status !== 'delivered') obj.status = 'skipped'; break; }
        if (f.flow === 'dismiss_object') break;
        k++;
      }
      tried.add(obj.id);
      log('object_end', { object: obj.id, status: obj.status });
      ctx.current = null;
    }
    i = j;
  }
  return finish('completed');
}
