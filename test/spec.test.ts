// Run: node --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion, addQuestion, approve, newPlan, setItems, setProse, type MissionPlan } from '../src/planning/plan.ts';
import { compileSpec, planHash, renderSpecMarkdown, type SitesFile } from '../src/planning/spec.ts';

const readyCaps = {
  behaviours: { goto: { status: 'verified' }, stop: { status: 'verified' }, push_to: { status: 'planned' } },
  vehicle_config: { fs_gcs_enable: { value: 1 } },
  power: { battery_monitoring: { value: true } },
  drive: { driven_by_pixhawk: { value: true } },
};
const sites: SitesFile = {
  sites: {
    lawn: {
      polygon: [[51.5, 7.5], [51.5, 7.5004], [51.5003, 7.5004], [51.5003, 7.5]],
      points: { ne_corner: [51.5003, 7.5004], home: [51.50005, 7.50005] },
    },
  },
};

function drivePlan(): MissionPlan {
  const p = newPlan('corner-run', 'Drive to the north-east corner of the lawn and back.');
  setProse(p, 'goal', 'Drive to the NE corner and back home.\n\nSecond paragraph.', 'planner');
  setProse(p, 'success', 's', 'planner');
  setItems(p, 'success', [{ id: 's1', criterion: 'reached the corner', measured_by: 'GPS within 2 m' }, { id: 's2', criterion: 'back home', measured_by: 'GPS within 2 m' }], 'planner');
  setProse(p, 'area', 'a', 'planner');
  setItems(p, 'area', { site: 'lawn', geofence: null, limits: { max_speed_mps: 0.5, max_duration_min: 10 }, targets: [{ name: 'ne_corner', lat: null, lon: null }, { name: 'home', lat: null, lon: null }] }, 'planner');
  setProse(p, 'configuration', 'c', 'planner');
  setItems(p, 'configuration', [{ need: 'Guided driving', provided_by: 'behaviours.goto', status: 'available' }], 'planner');
  setProse(p, 'phases', 'p', 'planner');
  setItems(p, 'phases', [
    { id: 'p1', name: 'to the corner', behaviour: 'goto', params: { target: 'ne_corner', max_speed_mps: 0.5 }, exit_condition: 'within 2 m', on_failure: 'HOLD, ask operator', serves: ['s1'] },
    { id: 'p2', name: 'home', behaviour: 'goto', params: { target: 'home' }, exit_condition: 'within 2 m', on_failure: 'HOLD, ask operator', serves: ['s2'] },
  ], 'planner');
  setProse(p, 'safety', 's', 'planner');
  setItems(p, 'safety', [{ condition: 'link lost', action: 'vehicle failsafe: HOLD' }, { condition: 'battery low', action: 'operator: RTL' }], 'planner');
  addQuestion(p, { slot: 'area', question: 'Which corner?', why: 'NE' });
  answerQuestion(p, 'q1', 'NE');
  approve(p);
  return p;
}

test('compiles a ready plan, resolving targets and the geofence from the site', () => {
  const r = compileSpec(drivePlan(), readyCaps, sites, new Date('2026-11-21T12:00:00Z'));
  assert.ok(r.ok, r.ok ? '' : r.blockers.join('\n'));
  const spec = r.spec;
  assert.equal(spec.goal, 'Drive to the NE corner and back home.');
  assert.equal(spec.geofence.length, 4);
  assert.deepEqual(spec.steps[0]!.params['target'], { target: 'ne_corner', lat: 51.5003, lon: 7.5004 });
  assert.deepEqual(spec.steps[1]!.serves, ['s2']);
  const md = renderSpecMarkdown(spec);
  assert.match(md, /p1\. \*\*to the corner\*\* — `goto\(target=ne_corner \(51\.500300, 7\.500400\), max_speed_mps=0\.5\)` · serves s1/);
  assert.match(md, /battery low → operator: RTL/);
});

test('the plan hash changes when the plan content changes', () => {
  const a = drivePlan();
  const b = drivePlan();
  assert.equal(planHash(a), planHash(b));
  b.sections.goal.prose += ' changed';
  assert.notEqual(planHash(a), planHash(b));
});

test('refuses with blockers while anything is not executable', () => {
  const p = drivePlan();
  p.status = 'draft';
  const phases = p.sections.phases.items as any[];
  phases.push({ id: 'p3', name: 'push', behaviour: 'push_to', params: { target: 'drop corner (pending operator)', speed_mps: 1.0 }, exit_condition: 'x', on_failure: 'y', serves: ['s9'] });
  phases.push({ id: 'p4', name: 'approach', behaviour: 'goto', params: { align_to: 'object' }, exit_condition: 'x', on_failure: 'y', serves: [] });
  (p.sections.configuration.items as any[]).push({ need: 'front plow', provided_by: null, status: 'missing' });
  const caps = { ...readyCaps, vehicle_config: { fs_gcs_enable: { value: 0 } }, power: { battery_monitoring: { value: false } }, drive: {} };
  const r = compileSpec(p, caps, { sites: {} });
  assert.equal(r.ok, false);
  const b = r.ok ? [] : r.blockers;
  const has = (re: RegExp) => assert.ok(b.some((x) => re.test(x)), `expected ${re} in\n${b.join('\n')}`);
  has(/plan is not approved/);
  has(/site "lawn" is not in the sites file/);
  has(/no geofence/);
  has(/target "ne_corner" has no coordinates/);
  has(/needs "front plow", which is missing/);
  has(/phase p3: behaviour "push_to" is planned/);
  has(/phase p3: parameter "target" is a placeholder/);
  has(/phase p4: parameter "align_to" names "object", which is not a target/);
  has(/phase p3: speed 1 m\/s is above the mission limit 0.5/);
  has(/phase p3: serves unknown success criterion "s9"/);
  has(/FS_GCS_ENABLE must be 1/);
  has(/battery monitoring is off/);
  has(/not confirmed driven by the Pixhawk/);
});

test('the pre-flight asks the operator to re-check what they vouched for and waived', () => {
  const p = drivePlan();
  p.status = 'draft';
  (p.sections.configuration.items as any[]).push({ need: 'waypoint radius 0.5 m', provided_by: 'operator: the executor enforces its own radius', status: 'available' });
  p.findings = [{ id: 'v3', slot: 'phases', kind: 'inconsistency', severity: 'error', text: 'WP_RADIUS is not harmless for p7a', source: 'validator', waived: { reason: 'moot: goto stops at its own radius', at: '' } }];
  p.status = 'approved';
  const r = compileSpec(p, readyCaps, sites);
  assert.ok(r.ok, r.ok ? '' : r.blockers.join('\n'));
  const pf = r.spec.preflight.join('\n');
  assert.match(pf, /Check what you vouched for: "waypoint radius 0.5 m" \(the executor enforces its own radius\)/);
  assert.match(pf, /Waived finding v3: WP_RADIUS is not harmless for p7a You accepted it because: moot/);
  assert.match(renderSpecMarkdown(r.spec), /## Operator pre-flight[\s\S]*- \[ \] Waived finding v3/);
});
