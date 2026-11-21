// Mission spec: the approved plan compiled into what the executor runs.
//
// The plan is where the mission is negotiated; the spec is the frozen, executable result.
// Compiling is deterministic (no LLM) and is a second gate after approval: it refuses, with a
// list of blockers, while anything in the plan can't actually run on the rover today.

import { createHash } from 'node:crypto';
import type { AreaItems, ConfigItem, MissionPlan, PhaseItem, SafetyItem, SuccessItem } from './plan.ts';

type Caps = Record<string, any>;
type LatLon = [number, number];

/** rover/sites.yaml: named areas, each with a boundary polygon and named points. */
export interface SitesFile {
  sites?: Record<string, { polygon?: LatLon[]; points?: Record<string, LatLon>; note?: string }>;
}

export interface SpecStep {
  id: string;
  name: string;
  behaviour: string;
  params: Record<string, unknown>;
  exit: string;
  on_failure: string;
  serves: string[];
}

export interface MissionSpec {
  spec_version: 1;
  mission: string;
  title: string;
  goal: string;
  compiled_at: string;
  plan_round: number;
  /** sha256 of the plan content the spec was compiled from (sections, answers). */
  plan_hash: string;
  limits: { max_speed_mps: number; max_duration_min: number | null };
  geofence: LatLon[];
  no_go: Array<{ name: string; polygon?: LatLon[]; note?: string }>;
  targets: Record<string, { lat: number; lon: number; note?: string }>;
  success: Array<{ id: string; criterion: string; measured_by: string; target?: string }>;
  /** What the operator does before handing over (the agent can't). */
  preflight: string[];
  steps: SpecStep[];
  aborts: Array<{ condition: string; action: string }>;
}

export type CompileResult = { ok: true; spec: MissionSpec } | { ok: false; blockers: string[] };

const PLACEHOLDER = /\b(pending|tbd|to be (decided|confirmed|measured|set|defined)|unknown|placeholder)\b/i;

export function planHash(plan: MissionPlan): string {
  const content = { request: plan.request, sections: plan.sections, answers: plan.questions.map((q) => [q.id, q.answer?.text ?? null]) };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function isLatLon(v: unknown): v is LatLon {
  return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

export function compileSpec(plan: MissionPlan, caps: Caps, sites: SitesFile = {}, now = new Date()): CompileResult {
  const blockers: string[] = [];
  const block = (s: string) => blockers.push(s);

  if (plan.status !== 'approved') block('the plan is not approved');

  const s = plan.sections;
  const area = (s.area.items ?? {}) as AreaItems;
  const site = area.site ? sites.sites?.[area.site] : undefined;
  if (area.site && !site) block(`site "${area.site}" is not in the sites file`);

  // geofence: from the plan, else the site's boundary
  const geofence = (area.geofence?.length ? area.geofence : site?.polygon) ?? null;
  if (!geofence || geofence.length < 3 || !geofence.every(isLatLon)) block('no geofence polygon with at least 3 valid points');

  // targets: plan coordinates, else the site's named points
  const targets: MissionSpec['targets'] = {};
  for (const t of area.targets ?? []) {
    const fromSite = site?.points?.[t.name];
    const lat = t.lat ?? fromSite?.[0];
    const lon = t.lon ?? fromSite?.[1];
    if (typeof lat !== 'number' || typeof lon !== 'number') block(`target "${t.name}" has no coordinates (neither in the plan nor in the site's points)`);
    else targets[t.name] = { lat, lon, ...(t.note ? { note: t.note } : {}) };
  }

  const maxSpeed = area.limits?.max_speed_mps;
  if (typeof maxSpeed !== 'number' || maxSpeed <= 0) block('no maximum speed in the area limits');
  const maxDuration = typeof area.limits?.max_duration_min === 'number' ? area.limits.max_duration_min : null;

  // configuration: everything needed must be available
  for (const c of (s.configuration.items ?? []) as ConfigItem[]) {
    if (c.status !== 'available') block(`needs "${c.need}", which is ${c.status}`);
  }

  // steps
  const behaviours: Record<string, { status?: string; params?: string[] }> = caps['behaviours'] ?? {};
  const successIds = new Set(((s.success.items ?? []) as SuccessItem[]).map((x) => x.id));
  const steps: SpecStep[] = [];
  const phases = (s.phases.items ?? []) as PhaseItem[];
  if (!phases.length) block('the plan has no phases');
  for (const p of phases) {
    const b = behaviours[p.behaviour];
    if (!b) block(`phase ${p.id}: behaviour "${p.behaviour}" doesn't exist`);
    else if (b.status !== 'verified') block(`phase ${p.id}: behaviour "${p.behaviour}" is ${b.status ?? 'not verified'}, not built yet`);
    const params = resolveParams(p.params ?? {}, targets, (msg) => block(`phase ${p.id}: ${msg}`));
    const speed = params['max_speed_mps'] ?? params['speed_mps'] ?? params['forward'];
    if (typeof speed === 'number' && typeof maxSpeed === 'number' && Math.abs(speed) > maxSpeed) {
      block(`phase ${p.id}: speed ${speed} m/s is above the mission limit ${maxSpeed} m/s`);
    }
    const serves = (p as PhaseItem & { serves?: unknown }).serves;
    const servesList = Array.isArray(serves) ? serves.map(String) : [];
    for (const id of servesList) if (!successIds.has(id)) block(`phase ${p.id}: serves unknown success criterion "${id}"`);
    steps.push({ id: p.id, name: p.name, behaviour: p.behaviour, params, exit: p.exit_condition, on_failure: p.on_failure, serves: servesList });
  }
  for (const id of successIds) {
    if (phases.some((p) => Array.isArray((p as { serves?: unknown }).serves)) && !steps.some((st) => st.serves.includes(id))) {
      block(`success criterion ${id} isn't served by any phase`);
    }
  }

  // vehicle preconditions the operator can't fix at the field
  const aborts = ((s.safety.items ?? []) as SafetyItem[]).map((a) => ({ condition: a.condition, action: a.action }));
  if (!aborts.length) block('no abort conditions');
  const vc = caps['vehicle_config'] ?? {};
  if (vc.fs_gcs_enable?.value !== 1) block('vehicle: GCS failsafe is off (FS_GCS_ENABLE must be 1 before the agent drives)');
  if (aborts.some((a) => /battery/i.test(`${a.condition} ${a.action}`)) && caps['power']?.battery_monitoring?.value !== true) {
    block('vehicle: battery monitoring is off, so the battery abort condition can\'t fire');
  }
  if (caps['drive']?.driven_by_pixhawk?.value !== true) block('vehicle: the motors are not confirmed driven by the Pixhawk (drive.driven_by_pixhawk)');

  if (blockers.length) return { ok: false, blockers };

  const firstLine = (t: string) => t.split(/\n\s*\n/)[0]!.replace(/\s+/g, ' ').trim();
  const spec: MissionSpec = {
    spec_version: 1,
    mission: plan.id,
    title: plan.title,
    goal: firstLine(s.goal.prose),
    compiled_at: now.toISOString(),
    plan_round: plan.round,
    plan_hash: planHash(plan),
    limits: { max_speed_mps: maxSpeed as number, max_duration_min: maxDuration },
    geofence: geofence as LatLon[],
    no_go: area.no_go ?? [],
    targets,
    success: ((s.success.items ?? []) as SuccessItem[]).map(({ id, criterion, measured_by, target }) => ({ id, criterion, measured_by, ...(target ? { target } : {}) })),
    preflight: [
      'Place the rover inside the geofence, power it up, check the camera stream and the LiDAR.',
      `Apply the mission's geofence proposal in Ardudeck (${(geofence as LatLon[]).length} points) and enable the fence.`,
      'Confirm FS_GCS_ENABLE=1 and the battery level in Ardudeck.',
      'Arm, switch to GUIDED to hand over. Any other mode takes control back.',
    ],
    steps,
    aborts,
  };
  return { ok: true, spec };
}

/** Replace target names with coordinates; refuse nulls and placeholder text. */
function resolveParams(params: Record<string, unknown>, targets: MissionSpec['targets'], problem: (msg: string) => void): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) { problem(`parameter "${k}" has no value`); continue; }
    if (typeof v === 'string') {
      const t = targets[v];
      if (t) { out[k] = { target: v, lat: t.lat, lon: t.lon }; continue; }
      if (PLACEHOLDER.test(v)) { problem(`parameter "${k}" is a placeholder ("${v}")`); continue; }
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      out[k] = resolveParams(v as Record<string, unknown>, targets, (msg) => problem(`${k}.${msg.replace(/^parameter /, '')}`));
      continue;
    }
    out[k] = v;
  }
  return out;
}

// --- the LLM briefing ----------------------------------------------------------------------

const fmt = (v: unknown): string => {
  if (v && typeof v === 'object' && 'lat' in v && 'lon' in v) {
    const t = v as { target?: string; lat: number; lon: number };
    return `${t.target ? `${t.target} ` : ''}(${t.lat.toFixed(6)}, ${t.lon.toFixed(6)})`;
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
};

/** One-page Markdown briefing for the LLM at decision points. */
export function renderSpecMarkdown(spec: MissionSpec): string {
  const L: string[] = [];
  L.push(`# Mission ${spec.mission}: ${spec.title}`, '');
  L.push(`Compiled ${spec.compiled_at} from plan round ${spec.plan_round} (plan ${spec.plan_hash.slice(0, 12)}).`, '');
  L.push(`**Goal:** ${spec.goal}`, '');
  L.push(`**Limits:** max ${spec.limits.max_speed_mps} m/s${spec.limits.max_duration_min ? `, max ${spec.limits.max_duration_min} min` : ''}, stay inside the ${spec.geofence.length}-point geofence.`);
  if (spec.no_go.length) L.push(`**No-go:** ${spec.no_go.map((n) => n.name).join('; ')}.`);
  const tnames = Object.entries(spec.targets);
  if (tnames.length) L.push(`**Targets:** ${tnames.map(([n, t]) => `${n} (${t.lat.toFixed(6)}, ${t.lon.toFixed(6)})`).join(', ')}.`);
  L.push('', '## Success', '');
  for (const c of spec.success) L.push(`- **${c.id}** ${c.criterion}${c.target ? ` — target: ${c.target}` : ''} *(measured by ${c.measured_by})*`);
  L.push('', '## Steps', '');
  for (const st of spec.steps) {
    const params = Object.entries(st.params).map(([k, v]) => `${k}=${fmt(v)}`).join(', ');
    L.push(`${st.id}. **${st.name}** — \`${st.behaviour}(${params})\`${st.serves.length ? ` · serves ${st.serves.join(', ')}` : ''}`);
    L.push(`   - done when: ${st.exit}`);
    L.push(`   - on failure: ${st.on_failure}`);
  }
  L.push('', '## Abort at once', '');
  for (const a of spec.aborts) L.push(`- ${a.condition} → ${a.action}`);
  L.push('', 'You may only use the behaviours in the steps. Arming, mode changes and fence/mission changes are the operator\'s. If reality doesn\'t match this spec, stop (HOLD) and ask for a re-plan.', '');
  return L.join('\n');
}
