#!/usr/bin/env node
// Build, approve and compile a small test mission for ArduRover SITL (ArduPilot's default
// test field, home -35.363261, 149.165230): drive a 15 m square at 0.5 m/s, turn in place,
// return home. No LLM involved.
//
//   node scripts/sitl-mission.ts            -> <missions>/sitl-square/{plan,spec}.*
//   node scripts/run.ts sitl-square         -> execute it (SITL + Ardudeck + module running)
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
  },
};

const caps = parseYaml(readFileSync(capsPath, 'utf-8')) as Record<string, any>;
caps['vehicle_config'].fs_gcs_enable = { value: 1, status: 'configured', source: 'SITL defaults' };
caps['power'].battery_monitoring = { value: true, status: 'configured', source: 'SITL simulated battery' };
caps['drive'].driven_by_pixhawk = { value: true, status: 'verified', source: 'SITL' };

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
setProse(plan, 'safety', 'Standard stops.', 'operator');
setItems(plan, 'safety', [
  { condition: 'link to the ground station lost', action: 'executor pauses; vehicle GCS failsafe holds' },
  { condition: 'rover leaves the geofence', action: 'executor stops the rover and aborts' },
  { condition: 'mission takes longer than 10 minutes', action: 'executor stops the rover and aborts' },
  { condition: 'battery low', action: 'operator: RTL' },
], 'operator');
approve(plan);

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
