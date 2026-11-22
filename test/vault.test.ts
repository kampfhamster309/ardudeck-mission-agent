// Run: node --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNote, searchText, searchVault, vaultDir } from '../src/vault/vault.ts';
import { runDebrief } from '../src/vault/debrief.ts';
import type { ChatFn } from '../src/planning/llm.ts';

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  writeFileSync(join(dir, 'VAULT-INDEX.md'), '---\nstatus: active\ntype: index\n---\n# VAULT INDEX\n');
  mkdirSync(join(dir, 'Behaviours'));
  writeFileSync(join(dir, 'Behaviours', 'push_to - bare front.md'), '---\nstatus: active\ntype: lesson\nenvironment: sim\n---\n# push_to - bare front\n\nA bare front loses the ball sideways within 2 s.\n');
  writeFileSync(join(dir, 'Behaviours', 'goto - arrival.md'), '---\nstatus: proposed\ntype: lesson\n---\nWP_RADIUS parks the rover short.\n');
  writeFileSync(join(dir, 'Behaviours', 'old.md'), '---\nstatus: outdated\n---\nthe ball rolls under the front\n');
  return dir;
}

test('vault search: accepted notes only by default, ranked, with the matching lines', () => {
  const dir = makeVault();
  const hits = searchVault(dir, 'push the ball');
  assert.deepEqual(hits.map((h) => h.note.path), ['Behaviours/push_to - bare front']);
  assert.match(hits[0]!.lines[0]!, /loses the ball/);
  assert.match(searchText(dir, 'WP_RADIUS'), /No accepted notes/);
  assert.match(searchText(dir, 'WP_RADIUS', ['active', 'proposed']), /goto - arrival.*proposed/);
  assert.match(searchText(dir, 'ball front'), /environment: sim/);
});

test('vault read stays inside the vault; vaultDir needs a VAULT-INDEX', () => {
  const dir = makeVault();
  assert.match(readNote(dir, '[[Behaviours/push_to - bare front]]'), /loses the ball/);
  assert.throws(() => readNote(dir, '../../etc/passwd'), /outside the vault/);
  assert.throws(() => readNote(dir, 'Behaviours/nothing'), /no note/);
  assert.equal(vaultDir({ MISSION_VAULT: dir }), dir);
  assert.equal(vaultDir({ MISSION_VAULT: 'off' }), null);
  assert.equal(vaultDir({ MISSION_VAULT: tmpdir() }), null);
});

test('debrief writes a proposed run report and lessons; an existing note gets a proposed edit beside it', async () => {
  const dir = makeVault();
  const script = [
    [{ name: 'vault_search', args: { query: 'push ball front' } }],
    [{ name: 'write_run_report', args: { result: '0 of 3 delivered', body: '---\nstatus: active\n---\nAll pushes failed.' } }],
    [{ name: 'propose_lesson', args: { path: 'Behaviours/push_to - bare front', body: 'Fails in 3 of 3 pushes.', why: 'p4 x3' } }],
    [{ name: 'propose_lesson', args: { path: 'Strategy/Pushing balls', body: 'Fit an attachment.', why: 'ground truth' } }],
    [{ name: 'propose_lesson', args: { path: 'Elsewhere/x', body: 'x', why: 'x' } }],
    [{ name: 'done', args: {} }],
  ];
  let i = 0;
  const seen: string[] = [];
  const chat: ChatFn = async (msgs) => {
    const last = msgs.at(-1);
    if (last && last.role === 'tool') seen.push(String(last.content));
    const calls = script[i++]!;
    return { content: null, tool_calls: calls.map((c, n) => ({ id: `t${i}-${n}`, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
  };
  const out = await runDebrief(dir, {
    mission: 'm1', run: '2026-11-22T17-25-56-984Z', environment: 'sim', spec: 'spec', events: '{}', result: '{}', date: '2026-11-22',
  }, chat, 'system');
  assert.equal(out.report, 'Runs/2026-11-22 m1 17-25-56');
  const report = readFileSync(join(dir, 'Runs', '2026-11-22 m1 17-25-56.md'), 'utf-8');
  assert.match(report, /^---\nstatus: proposed\ntype: run\nenvironment: sim/);
  assert.doesNotMatch(report, /status: active/, 'the agent cannot set its own status');
  // the existing note is untouched; the edit sits beside it
  assert.match(readFileSync(join(dir, 'Behaviours', 'push_to - bare front.md'), 'utf-8'), /within 2 s/);
  const edit = readFileSync(join(dir, 'Proposals', 'Behaviours - push_to - bare front (2026-11-22).md'), 'utf-8');
  assert.match(edit, /status: proposed[\s\S]*edit_of: "\[\[Behaviours\/push_to - bare front\]\]"[\s\S]*3 of 3/);
  assert.match(edit, /evidence:\n {2}- "\[\[Runs\/2026-11-22 m1 17-25-56\]\]"/);
  assert.ok(existsSync(join(dir, 'Strategy', 'Pushing balls.md')));
  assert.deepEqual(out.proposals, ['Proposals/Behaviours - push_to - bare front (2026-11-22)', 'Strategy/Pushing balls']);
  assert.ok(seen.some((s) => /path must be/.test(s)), 'a lesson outside the lesson folders is refused');
});
