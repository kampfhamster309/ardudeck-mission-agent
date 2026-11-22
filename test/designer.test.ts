// Run: node --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPlan, setItems, setProse } from '../src/planning/plan.ts';
import { designDiscrepancies, missingAttachments, type AddonDesign } from '../src/planning/designer.ts';
import { DEFAULT_CONFIG, World } from '../sim/world.ts';

test('missing attachments: only physical add-ons that are missing', () => {
  const p = newPlan('m', 'x');
  setProse(p, 'configuration', 'c', 'planner');
  setItems(p, 'configuration', [
    { need: 'Front plow to gather balls', provided_by: null, status: 'missing' },
    { need: 'GCS failsafe on', provided_by: 'vehicle_config.fs_gcs_enable', status: 'missing' },
    { need: 'camera', provided_by: 'sensors.camera_c270', status: 'available' },
  ], 'planner');
  assert.deepEqual(missingAttachments(p).map((c) => c.need), ['Front plow to gather balls']);
});

test('design discrepancies: claimed vs measured size, parts vs the print bed', () => {
  const d = {
    overall_mm: { x: 120, y: 300, z: 78 },
    measured: {
      bbox_min: [0, -150, 7], bbox_max: [128, 150, 78], size_mm: [128, 300, 71], volume_mm3: 1, bodies: 2,
      parts: [{ name: 'Plate', size_mm: [128, 150, 71], volume_mm3: 1 }, { name: 'Wing', size_mm: [100, 260, 60], volume_mm3: 1 }],
    },
  } as unknown as AddonDesign;
  const issues = designDiscrepancies(d, 3, [220, 220, 250]);
  assert.ok(issues.some((i) => /overall x: claimed 120 mm, measured 128 mm/.test(i)));
  assert.ok(!issues.some((i) => /overall z/.test(i)), 'a height given from the ground is fine');
  assert.ok(issues.some((i) => /part Wing .* doesn't fit/.test(i)), issues.join('\n'));
  assert.ok(!issues.some((i) => /part Plate/.test(i)));
});

test('a plow mouth narrower than the ball acts like a flat front', () => {
  const pushStraight = (width: number) => {
    const w = new World([{ id: 'b', east: 0, north: 0.4, r: 0.03 }], { ...DEFAULT_CONFIG, plow: { fitted: true, width_m: width, depth_m: 0.12 } });
    let n = 0;
    for (let i = 0; i < 40; i++) { n += 0.02; w.step({ east: 0, north: n, heading_deg: 0, speed: 0.2 }); }
    return Math.abs(w.balls[0]!.east);
  };
  assert.ok(pushStraight(0.3) < 0.13, 'kept in a 300 mm mouth');
  assert.ok(pushStraight(0.05) > 0.1, 'slides off a 50 mm "mouth"');
});

test('a funnel guides an off-centre ball into a narrow mouth', () => {
  const push = (entry: number | undefined) => {
    const w = new World([{ id: 'b', east: 0.1, north: 0.45, r: 0.03 }], { ...DEFAULT_CONFIG, plow: { fitted: true, width_m: 0.09, depth_m: 0.12, ...(entry ? { entry_width_m: entry } : {}) } });
    let n = 0;
    for (let i = 0; i < 60; i++) { n += 0.02; w.step({ east: 0, north: n, heading_deg: 0, speed: 0.2 }); }
    return { lateral: Math.abs(w.balls[0]!.east), carried: w.balls[0]!.north > 1.2 };
  };
  const funnel = push(0.35);
  assert.ok(funnel.carried && funnel.lateral < 0.02, `funnel: ${JSON.stringify(funnel)}`);
  const narrow = push(undefined);
  assert.ok(!(narrow.carried && narrow.lateral < 0.02), `straight 90 mm U should not centre a ball 100 mm off: ${JSON.stringify(narrow)}`);
});

test('leadingJson reads the JSON before a trailing note', async () => {
  const { leadingJson } = await import('../src/planning/designer.ts');
  assert.deepEqual(leadingJson('{\n "a": "x}y", "b": [1, {"c": 2}]\n}\nNote: this is a headless session'), { a: 'x}y', b: [1, { c: 2 }] });
  assert.deepEqual(leadingJson('[1,2] trailing'), [1, 2]);
  assert.equal(leadingJson(' 42 '), 42);
});
