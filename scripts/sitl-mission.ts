#!/usr/bin/env node
// Build, approve and compile test missions for ArduRover SITL (ArduPilot's default test field,
// home -35.363261, 149.165230). No LLM involved.
//
//   node scripts/sitl-mission.ts [square]   -> sitl-square: 15 m square at 0.5 m/s, turn, home
//   node scripts/sitl-mission.ts balls      -> sitl-balls: survey, push each ball into the
//                                              corner, verify, home (needs scripts/sim-world.ts)
//   node scripts/run.ts <id>                -> execute it (SITL + Ardudeck + module running)
//
// Compiled against the real capability model with the vehicle preconditions overridden for
// the simulated rover (GCS failsafe on, battery monitored, motors driven by the autopilot).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { approve, newPlan, renderMarkdown, setItems, setProse } from '../src/planning/plan.ts';
import { compileSpec, renderSpecMarkdown, type SitesFile } from '../src/planning/spec.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const capsPath = resolve(repo, process.env['MISSION_CAPS'] ?? '../rover/capabilities.yaml');
const missionDir = resolve(repo, process.env['MISSION_DIR'] ?? '../missions');

const HOME: [number, number] = [-35.363261, 149.16523];
const at = (north: number, east: number): [number, number] => [
  +(HOME[0] + north / 111_320).toFixed(7),
  +(HOME[1] + east / (111_320 * Math.cos((HOME[0] * Math.PI) / 180))).toFixed(7),
];

const sites: SitesFile = {
  sites: {
    sitl_field: {
      note: 'ArduPilot SITL default location; simulation only',
      polygon: [at(-15, -15), at(-15, 30), at(30, 30), at(30, -15)],
      points: { home: HOME, a: at(15, 0), b: at(15, 15), c: at(0, 15) },
    },
    sitl_balls: {
      note: 'ArduPilot SITL default location; field for scripts/sim-world.ts balls',
      polygon: [at(-2, -2), at(-2, 12), at(12, 12), at(12, -2)],
      points: { home: HOME, drop_corner: at(9, 9) },
    },
  },
};

const caps = parseYaml(readFileSync(capsPath, 'utf-8')) as Record<string, any>;
caps['vehicle_config'].fs_gcs_enable = { value: 1, status: 'configured', source: 'SITL defaults' };
caps['power'].battery_monitoring = { value: true, status: 'configured', source: 'SITL simulated battery' };
caps['drive'].driven_by_pixhawk = { value: true, status: 'verified', source: 'SITL' };
// the simulated world (scripts/sim-world.ts) provides what the real rover doesn't have yet
for (const b of ['survey', 'hold_and_look', 'approach', 'push_to', 'back_off']) {
  caps['behaviours'][b] = { ...(caps['behaviours'][b] ?? {}), status: 'verified', source: 'SITL + simulated world' };
}

const which = process.argv[2] ?? 'square';
const plan = which === 'balls' ? ballsPlan() : squarePlan();

function squarePlan() {
  const plan = newPlan('sitl-square', 'Drive a 15 m square on the SITL field at walking pace, turn on the spot, come home.', 'SITL square');
  setProse(plan, 'goal', 'Exercise the executor end to end in SITL: three corners of a 15 m square, a turn in place, back home.', 'operator');
  setProse(plan, 'success', 'Each corner and home are reached within the arrival radius.', 'operator');
  setItems(plan, 'success', [
    { id: 's1', criterion: 'all three corners reached', measured_by: 'executor goto completion (within 2 m, stopped)' },
    { id: 's2', criterion: 'back home', measured_by: 'executor goto completion (within 2 m, stopped)' },
  ], 'operator');
  setProse(plan, 'area', 'The SITL field, 45 x 45 m around home. 0.5 m/s, 10 minutes.', 'operator');
  setItems(plan, 'area', {
    site: 'sitl_field', geofence: null, no_go: [], limits: { max_speed_mps: 0.5, max_duration_min: 10 },
    targets: ['a', 'b', 'c', 'home'].map((name) => ({ name, lat: null, lon: null })),
  }, 'operator');
  setProse(plan, 'configuration', 'Guided driving only.', 'operator');
  setItems(plan, 'configuration', [{ need: 'Guided goto and velocity', provided_by: 'behaviours.goto', status: 'available' }], 'operator');
  setProse(plan, 'phases', 'Corners a, b, c, a turn in place, home, stop.', 'operator');
  setItems(plan, 'phases', [
    { id: 'p1', name: 'corner a', behaviour: 'goto', params: { target: 'a' }, exit_condition: 'within 2 m, stopped', on_failure: 'retry once, then hold for the operator', serves: ['s1'] },
    { id: 'p2', name: 'corner b', behaviour: 'goto', params: { target: 'b' }, exit_condition: 'within 2 m, stopped', on_failure: 'retry once, then hold for the operator', serves: ['s1'] },
    { id: 'p3', name: 'corner c', behaviour: 'goto', params: { target: 'c' }, exit_condition: 'within 2 m, stopped', on_failure: 'retry once, then hold for the operator', serves: ['s1'] },
    { id: 'p4', name: 'turn in place', behaviour: 'velocity', params: { forward_mps: 0, yaw_rate_rps: 0.5, seconds: 4 }, exit_condition: 'after 4 s', on_failure: 'skip', serves: [] },
    { id: 'p5', name: 'home', behaviour: 'goto', params: { target: 'home' }, exit_condition: 'within 2 m, stopped', on_failure: 'hold for the operator', serves: ['s2'] },
    { id: 'p6', name: 'halt', behaviour: 'stop', params: {}, exit_condition: 'at once', on_failure: 'hold', serves: [] },
  ], 'operator');
  safety(plan, 10);
  approve(plan);
  return plan;
}

/** The red-ball mission in miniature: balls from scripts/sim-world.ts, pushed into corner (9, 9). */
function ballsPlan() {
  const plan = newPlan('sitl-balls', 'Find the red balls in the 10 x 10 m field and push them into the north-east corner.', 'SITL red balls');
  setProse(plan, 'goal', 'Find every red ball on the field and push it into the drop corner (simulated balls, plow and Ferret).', 'operator');
  setProse(plan, 'success', 'A final verify survey finds no ball outside 1.5 m of the corner.', 'operator');
  setItems(plan, 'success', [{ id: 's1', criterion: 'every ball within 1.5 m of the drop corner', measured_by: 'verify survey (camera + Ferret), and the simulator ground truth' }], 'operator');
  setProse(plan, 'area', 'A 14 x 14 m field next to home. 0.5 m/s, 40 minutes.', 'operator');
  setItems(plan, 'area', {
    site: 'sitl_balls', geofence: null, no_go: [], limits: { max_speed_mps: 0.5, max_duration_min: 40 },
    targets: [{ name: 'drop_corner', lat: null, lon: null }, { name: 'home', lat: null, lon: null }],
  }, 'operator');
  setProse(plan, 'configuration', 'Simulated plow and Ferret.', 'operator');
  setItems(plan, 'configuration', [
    { need: 'front plow', provided_by: 'attachments.front_plow (simulated)', status: 'available' },
    { need: 'close-range depth', provided_by: 'sensors.depth_ferret_pro (simulated)', status: 'available' },
  ], 'operator');
  setProse(plan, 'phases', 'Survey, then approach, push and back off per ball, verify, home.', 'operator');
  const zone = { target: 'drop_corner' };
  setItems(plan, 'phases', [
    { id: 'p1', name: 'find the balls', behaviour: 'survey', params: { ...zone, radius_m: 1.5 }, exit_condition: 'all legs driven', on_failure: 'hold for the operator', serves: [] },
    { id: 'p2', name: 'approach the ball', behaviour: 'approach', params: { for_each: 'object', block: 'gather', align_to: 'drop_corner' }, exit_condition: 'ball in the plow mouth', on_failure: 'retry the ball once, then skip it', serves: ['s1'] },
    { id: 'p3', name: 'push it into the corner', behaviour: 'push_to', params: { for_each: 'object', block: 'gather', target: 'drop_corner', radius_m: 1.1 }, exit_condition: 'ball within 1.1 m of the corner', on_failure: 'retry the ball once, then skip it', serves: ['s1'] },
    { id: 'p4', name: 'back off', behaviour: 'back_off', params: { for_each: 'object', block: 'gather', distance_m: 1.0 }, exit_condition: 'reversed 1 m', on_failure: 'skip', serves: [] },
    { id: 'p5', name: 'verify', behaviour: 'survey', params: { mode: 'verify', ...zone, radius_m: 1.5 }, exit_condition: 'no ball outside 1.5 m of the corner', on_failure: 'retry once, then hold for the operator', serves: ['s1'] },
    { id: 'p6', name: 'home', behaviour: 'goto', params: { target: 'home' }, exit_condition: 'within 2 m, stopped', on_failure: 'hold for the operator', serves: [] },
    { id: 'p7', name: 'halt', behaviour: 'stop', params: {}, exit_condition: 'at once', on_failure: 'hold', serves: [] },
  ], 'operator');
  safety(plan, 40);
  approve(plan);
  return plan;
}

function safety(plan: ReturnType<typeof newPlan>, minutes: number) {
  setProse(plan, 'safety', 'Standard stops.', 'operator');
  setItems(plan, 'safety', [
    { condition: 'link to the ground station lost', action: 'executor pauses; vehicle GCS failsafe holds' },
    { condition: 'rover leaves the geofence', action: 'executor stops the rover and aborts' },
    { condition: `mission takes longer than ${minutes} minutes`, action: 'executor stops the rover and aborts' },
    { condition: 'battery low', action: 'operator: RTL' },
  ], 'operator');
}

const r = compileSpec(plan, caps, sites);
if (!r.ok) {
  console.error(`can't compile:\n- ${r.blockers.join('\n- ')}`);
  process.exit(1);
}
const dir = join(missionDir, plan.id);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
writeFileSync(join(dir, 'plan.md'), renderMarkdown(plan));
writeFileSync(join(dir, 'spec.yaml'), toYaml(r.spec, { lineWidth: 100 }));
writeFileSync(join(dir, 'spec.md'), renderSpecMarkdown(r.spec));
console.log(renderSpecMarkdown(r.spec));
console.error(`wrote ${dir}/{plan,spec}.{json,md,yaml}`);
