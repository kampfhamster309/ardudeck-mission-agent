// Deterministic validator checks: the fixed checklist that code can decide reliably. The LLM
// validator gets the rest (contradictions, judgement calls against the capability model).

import type { AreaItems, ConfigItem, Finding, MissionPlan, PhaseItem, SafetyItem, SuccessItem } from './plan.ts';

type Caps = Record<string, any>;
type Draft = Omit<Finding, 'id' | 'source'>;

const blank = (s: unknown) => typeof s !== 'string' || !s.trim();

export function runChecks(plan: MissionPlan, caps: Caps): Finding[] {
  const out: Draft[] = [];
  const add = (f: Draft) => out.push(f);
  const s = plan.sections;

  // success: every criterion says how it's measured
  const success = (s.success.items ?? []) as SuccessItem[];
  if (s.success.prose && !success.length) {
    add({ slot: 'success', kind: 'incompleteness', severity: 'error', text: 'success criteria have no structured items (criterion + how it is measured)' });
  }
  for (const c of success) {
    if (blank(c.measured_by)) add({ slot: 'success', kind: 'incompleteness', severity: 'error', text: `criterion ${c.id} doesn't say how it is measured` });
  }

  // area: a geofence and a speed limit
  const area = (s.area.items ?? {}) as AreaItems;
  if (s.area.prose || s.area.items) {
    if (!area.geofence || area.geofence.length < 3) {
      add({ slot: 'area', kind: 'incompleteness', severity: 'error', text: 'no geofence polygon (at least 3 points); the operator needs one to apply before driving' });
    }
    if (area.limits?.max_speed_mps == null) {
      add({ slot: 'area', kind: 'incompleteness', severity: 'warning', text: 'no maximum speed for the mission' });
    }
  }

  // phases: exit condition + failure handling, behaviour exists and is built, operator-only actions
  const behaviours: Record<string, { status?: string; needs?: unknown }> = caps['behaviours'] ?? {};
  const operatorOnly: string[] = caps['operator_only'] ?? [];
  const phases = (s.phases.items ?? []) as PhaseItem[];
  const unbuilt: Record<string, string[]> = {};
  if (s.phases.prose && !phases.length) {
    add({ slot: 'phases', kind: 'incompleteness', severity: 'error', text: 'phases have no structured items' });
  }
  for (const p of phases) {
    if (blank(p.exit_condition)) add({ slot: 'phases', kind: 'incompleteness', severity: 'error', text: `phase ${p.id} has no exit condition` });
    if (blank(p.on_failure)) add({ slot: 'phases', kind: 'incompleteness', severity: 'error', text: `phase ${p.id} doesn't say what happens on failure` });
    const b = behaviours[p.behaviour];
    if (/^(arm|disarm|set_mode|mode)/i.test(p.behaviour)) {
      add({ slot: 'phases', kind: 'infeasibility', severity: 'error', text: `phase ${p.id} uses "${p.behaviour}", which is operator-only`, evidence: `capabilities: operator_only = ${operatorOnly.join('; ')}` });
    } else if (!b) {
      add({ slot: 'phases', kind: 'infeasibility', severity: 'error', text: `phase ${p.id} uses behaviour "${p.behaviour}", which the rover doesn't have`, evidence: `capabilities: behaviours = ${Object.keys(behaviours).join(', ')}` });
    } else if (b.status !== 'verified') {
      (unbuilt[p.behaviour] ??= []).push(p.id);
    }
    // places must be named targets of the area (resolved to coordinates when compiling)
    const targetNames = (area.targets ?? []).map((t) => t.name);
    for (const [k, v] of Object.entries(p.params ?? {})) {
      if (['target', 'destination', 'waypoint', 'align_to'].includes(k) && typeof v === 'string' && !targetNames.includes(v)) {
        add({ slot: 'phases', kind: 'inconsistency', severity: 'error', text: `phase ${p.id}: ${k} "${v}" is not one of the area's targets (${targetNames.join(', ') || 'none'})` });
      }
    }
    // perception rule: the Ferret is for close work only, never search
    if (/survey|search|scan|find/i.test(`${p.behaviour} ${p.name}`) && /ferret|depth/i.test(JSON.stringify(p.params ?? {}))) {
      add({ slot: 'phases', kind: 'infeasibility', severity: 'error', text: `phase ${p.id} searches with the depth camera; search is the C270's job, the Ferret is close work only (150-700 mm)`, evidence: 'capabilities: sensors.depth_ferret_pro.role' });
    }
  }

  // One finding per topic, not one per item: the plan's own sections hold the detail.
  if (Object.keys(unbuilt).length) {
    const list = Object.entries(unbuilt).map(([b, ids]) => `${b} (${ids.join(', ')})`).join(', ');
    add({ slot: 'phases', kind: 'infeasibility', severity: 'warning', text: `phases rely on behaviours that aren't built yet: ${list}`, evidence: 'capabilities: behaviours.*.status' });
  }

  // configuration: missing / unknown needs
  const config = (s.configuration.items ?? []) as ConfigItem[];
  const missing = config.filter((c) => c.status === 'missing').map((c) => c.need);
  const unknown = config.filter((c) => c.status === 'unknown').map((c) => c.need);
  if (missing.length) add({ slot: 'configuration', kind: 'infeasibility', severity: 'warning', text: `${missing.length} needs the rover doesn't meet yet: ${missing.join('; ')}` });
  if (unknown.length) add({ slot: 'configuration', kind: 'incompleteness', severity: 'warning', text: `unknown whether the rover provides: ${unknown.join('; ')}` });

  // safety: link loss and low battery must be covered
  const safety = (s.safety.items ?? []) as SafetyItem[];
  if (s.safety.prose || safety.length) {
    const conds = safety.map((x) => `${x.condition} ${x.action}`).join(' | ');
    if (!/link|connection|gcs|telemetry|heartbeat/i.test(conds)) {
      add({ slot: 'safety', kind: 'incompleteness', severity: 'error', text: 'no abort condition for losing the link to the ground station' });
    }
    if (!/battery/i.test(conds)) {
      add({ slot: 'safety', kind: 'incompleteness', severity: 'error', text: 'no abort condition for low battery' });
    }
    if (caps['vehicle_config']?.fs_gcs_enable?.value === 0) {
      add({ slot: 'safety', kind: 'infeasibility', severity: 'error', text: 'the vehicle has the GCS failsafe off (FS_GCS_ENABLE=0): on link loss in Guided the rover keeps driving to a position target', evidence: 'capabilities: vehicle_config.fs_gcs_enable' });
    }
    if (caps['power']?.battery_monitoring?.value === false && /battery/i.test(conds)) {
      add({ slot: 'safety', kind: 'infeasibility', severity: 'error', text: "a battery abort condition can't fire: the vehicle doesn't monitor its battery (BATT_MONITOR=0)", evidence: 'capabilities: power.battery_monitoring' });
    }
  }

  return out.map((f, i) => ({ ...f, id: `c${i + 1}`, source: 'check' as const }));
}
