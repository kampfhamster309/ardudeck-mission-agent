// Run: node --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addQuestion, answerQuestion, appendProse, approvalBlockers, approve, newPlan, PlanEditError, provideNeed, waiveFinding,
  renderMarkdown, setItems, setProse,
} from '../src/planning/plan.ts';
import { runChecks } from '../src/planning/checks.ts';
import { runPlannerRound, runValidation, type Context } from '../src/planning/agents.ts';
import type { ChatFn } from '../src/planning/llm.ts';

const caps = {
  behaviours: { velocity: { status: 'verified' }, goto: { status: 'verified' }, survey: { status: 'planned' } },
  operator_only: ['arm / disarm'],
  vehicle_config: { fs_gcs_enable: { value: 0 } },
  power: { battery_monitoring: { value: false } },
};
const ctx: Context = { capabilities: caps, sites: {}, capabilitiesText: 'behaviours: {}', sitesText: '' };

test('planner may not overwrite operator prose, but may extend it', () => {
  const p = newPlan('m1', 'push balls');
  setProse(p, 'goal', 'Operator words.', 'operator');
  assert.throws(() => setProse(p, 'goal', 'Planner words.', 'planner'), PlanEditError);
  appendProse(p, 'goal', 'Planner addition.', 'planner');
  assert.equal(p.sections.goal.prose, 'Operator words.\n\nPlanner addition.');
  assert.equal(p.sections.goal.prose_author, 'operator');
});

test('items are shape-checked per section', () => {
  const p = newPlan('m1', 'x');
  assert.throws(() => setItems(p, 'phases', [{ id: 'p1', name: 'go' }], 'planner'), /missing "behaviour"/);
  assert.throws(() => setItems(p, 'configuration', [{ need: 'plow', provided_by: null, status: 'maybe' }], 'planner'), /status must be/);
  assert.throws(() => setItems(p, 'goal', [], 'planner'), /prose only/);
  setItems(p, 'safety', [{ condition: 'link lost', action: 'HOLD' }], 'planner');
});

test('questions: no duplicates; approval needs answers, prose and no error findings', () => {
  const p = newPlan('m1', 'x');
  addQuestion(p, { slot: 'area', question: 'Which corner?', why: 'NE is closest' });
  assert.throws(() => addQuestion(p, { slot: 'area', question: 'which corner?', why: 'again' }), /already asked/);
  assert.ok(approvalBlockers(p).some((b) => b.includes('q1 is unanswered')));
  answerQuestion(p, 'q1', 'north-east');
  for (const s of ['goal', 'success', 'area', 'configuration', 'phases', 'safety']) setProse(p, s, 'text', 'operator');
  p.findings = [{ id: 'c1', slot: 'safety', kind: 'incompleteness', severity: 'error', text: 'x', source: 'check' }];
  assert.throws(() => approve(p), /finding c1/);
  p.findings = [];
  approve(p);
  assert.equal(p.status, 'approved');
  assert.throws(() => setProse(p, 'goal', 'late', 'operator'), /approved/);
});

test('checks find the fixed-checklist problems', () => {
  const p = newPlan('m1', 'x');
  setProse(p, 'phases', 'p', 'planner');
  setItems(p, 'phases', [
    { id: 'p1', name: 'search lawn', behaviour: 'survey', params: { sensor: 'ferret', target: 'nowhere' }, exit_condition: '', on_failure: 'HOLD' },
    { id: 'p2', name: 'fly', behaviour: 'teleport', exit_condition: 'there', on_failure: 'HOLD' },
    { id: 'p3', name: 'arm it', behaviour: 'arm', exit_condition: 'armed', on_failure: 'HOLD' },
  ], 'planner');
  setProse(p, 'safety', 's', 'planner');
  setItems(p, 'safety', [{ condition: 'battery below 30 %', action: 'operator: RTL' }], 'planner');
  setProse(p, 'area', 'a', 'planner');
  const texts = runChecks(p, caps).map((f) => `${f.severity} ${f.text}`);
  const has = (re: RegExp) => assert.ok(texts.some((t) => re.test(t)), `expected ${re} in\n${texts.join('\n')}`);
  has(/error phase p1 has no exit condition/);
  has(/warning phases rely on behaviours that aren't built yet: survey \(p1\)/);
  has(/error phase p1 searches with the depth camera/);
  has(/error phase p2 uses behaviour "teleport"/);
  has(/error phase p3 uses "arm", which is operator-only/);
  has(/error no abort condition for losing the link/);
  has(/error the vehicle has the GCS failsafe off/);
  has(/error a battery abort condition can't fire/);
  has(/error no geofence/);
  has(/phase p1: target "nowhere" is not one of the area's targets/);
});

test('planner round and validation with a scripted model', async () => {
  const script = [
    [{ name: 'read_plan', args: {} }],
    [{ name: 'set_prose', args: { slot: 'goal', text: 'Collect the balls.' } }, { name: 'add_question', args: { slot: 'area', question: 'Where is the lawn?', why: 'no sites defined' } }],
    [{ name: 'set_items', args: { slot: 'success', items: '[{"id":"s1","criterion":"all balls in corner","measured_by":"final survey"}]' } }],
    [{ name: 'done', args: { summary: 'first draft' } }],
    // validator
    [{ name: 'report_finding', args: { slot: 'phases', kind: 'inconsistency', severity: 'warning', text: 'no phase checks s1' } }],
    [{ name: 'done', args: {} }],
  ];
  let i = 0;
  const chat: ChatFn = async () => {
    const calls = script[i++]!;
    return { content: null, tool_calls: calls.map((c, n) => ({ id: `t${i}-${n}`, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
  };
  const p = newPlan('m1', 'push the red balls into the corner');
  const r = await runPlannerRound(p, ctx, chat);
  assert.equal(r.finished, true);
  assert.equal(r.summary, 'first draft');
  assert.equal(p.round, 1);
  assert.equal(p.sections.goal.prose, 'Collect the balls.');
  assert.equal(p.questions[0]!.id, 'q1');
  assert.equal((p.sections.success.items as unknown[]).length, 1);
  const f = await runValidation(p, ctx, chat);
  assert.ok(f.some((x) => x.id === 'v1' && x.source === 'validator'));
  assert.match(renderMarkdown(p), /q1 \(open\)/);
});

test('a waived error finding no longer blocks approval, and the waiver is shown and logged', () => {
  const p = newPlan('m1', 'x');
  for (const s of ['goal', 'success', 'area', 'configuration', 'phases', 'safety']) setProse(p, s, 'text', 'operator');
  p.findings = [{ id: 'v1', slot: 'phases', kind: 'inconsistency', severity: 'error', text: 'p7 sees half the lawn', source: 'validator' }];
  assert.throws(() => approve(p), /finding v1/);
  assert.throws(() => waiveFinding(p, 'v1', '  '), /needs a reason/);
  assert.throws(() => waiveFinding(p, 'v9', 'x'), /no finding v9/);
  waiveFinding(p, 'v1', 'the verify survey covers the whole lawn');
  assert.match(renderMarkdown(p), /v1 \(inconsistency\) \(waived\)[\s\S]*waived by the operator:\* the verify survey covers the whole lawn/);
  approve(p);
  assert.match(p.history.at(-1)!.action, /approved \(waived: v1\)/);
});

test('the operator can mark a configuration need as provided; an approved plan goes back to draft', () => {
  const p = newPlan('m1', 'x');
  for (const s of ['goal', 'success', 'area', 'configuration', 'phases', 'safety']) setProse(p, s, 'text', 'operator');
  setItems(p, 'configuration', [
    { need: 'Battery endurance for 30 min', provided_by: null, status: 'unknown' },
    { need: 'Track width', provided_by: null, status: 'unknown' },
  ], 'planner');
  approve(p);
  assert.throws(() => provideNeed(p, 'width', ' '), /say how/);
  assert.throws(() => provideNeed(p, 'nothing', 'x'), /matches 0/);
  const c = provideNeed(p, 'battery', 'SITL battery, 40 min verified');
  assert.equal(c.status, 'available');
  assert.equal(c.provided_by, 'operator: SITL battery, 40 min verified');
  assert.equal(p.status, 'draft');
});
