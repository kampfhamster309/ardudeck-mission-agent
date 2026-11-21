#!/usr/bin/env node
// Execute a compiled mission spec through the module's control port.
//
//   node scripts/run.ts <id> [--from <step>] [--agent http://127.0.0.1:8765] [--no-llm]
//
// Needs Ardudeck running with the module loaded and connected to the vehicle. The run starts
// when the operator arms and switches to GUIDED; any other mode pauses it. Decisions after a
// failed step go to the LLM (MISSION_LLM_URL / MISSION_LLM_MODEL), or straight to a hold
// with --no-llm. Each run is logged to <missions>/<id>/runs/<timestamp>/.

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { MissionPlan } from '../src/planning/plan.ts';
import { planHash, type MissionSpec } from '../src/planning/spec.ts';
import { llmConfigFromEnv, openAiChat } from '../src/planning/llm.ts';
import { runMission, classifyAborts, type MissionEvent } from '../src/executor/executor.ts';
import { HttpAgentClient } from '../src/executor/client.ts';
import { holdDecider, llmDecider } from '../src/executor/decide.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const missionDir = resolve(repo, process.env['MISSION_DIR'] ?? '../missions');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const id = process.argv[2];
  if (!id || id.startsWith('--')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(1, 10).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }
  const dir = join(missionDir, id);
  const specPath = join(dir, 'spec.yaml');
  if (!existsSync(specPath)) throw new Error(`no spec for "${id}": compile the approved plan first`);
  const spec = parseYaml(readFileSync(specPath, 'utf-8')) as MissionSpec;
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf-8')) as MissionPlan;
  if (plan.status !== 'approved') throw new Error('the plan is no longer approved; approve and compile it again');
  if (planHash(plan) !== spec.plan_hash) throw new Error('the plan changed after the spec was compiled; compile it again');

  const runDir = join(dir, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });
  const events = join(runDir, 'events.jsonl');

  const { monitored, unmonitored } = classifyAborts(spec);
  console.log(`Mission ${spec.mission}: ${spec.title}\n`);
  console.log('Operator pre-flight:');
  for (const p of spec.preflight) console.log(`  [ ] ${p}`);
  console.log('\nAbort conditions the executor watches:');
  for (const m of monitored) console.log(`  - ${m}`);
  if (unmonitored.length) {
    console.log('NOT watched by the executor (the operator has to):');
    for (const u of unmonitored) console.log(`  - ${u}`);
  }
  console.log(`\nLog: ${events}\n`);

  const useLlm = !process.argv.includes('--no-llm');
  const quiet = (s: string) => appendFileSync(join(runDir, 'llm.log'), s + '\n');
  const decide = useLlm ? llmDecider(openAiChat(llmConfigFromEnv(), quiet), quiet) : holdDecider;
  const t0 = Date.now();
  const show = (e: MissionEvent) => {
    appendFileSync(events, JSON.stringify(e) + '\n');
    const { t, type, ...rest } = e;
    const details = Object.entries(rest).filter(([k, v]) => v !== undefined && !['steps', 'monitored', 'unmonitored', 'criteria'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    console.log(`${((t - t0) / 1000).toFixed(1).padStart(7)} s  ${type.padEnd(20)} ${details}`);
  };

  const result = await runMission(spec, {
    client: new HttpAgentClient(arg('--agent')),
    decide,
    log: show,
    fromStep: arg('--from'),
  });
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');

  console.log(`\n${result.status.toUpperCase()}${result.reason ? `: ${result.reason}` : ''}`);
  for (const s of result.steps) console.log(`  ${s.id.padEnd(5)} ${s.outcome.padEnd(8)} ${s.attempts} attempt(s)${s.detail ? `  ${s.detail}` : ''}`);
  console.log('Success criteria (steps serving them all done?):');
  for (const c of result.criteria) console.log(`  ${c.id.padEnd(5)} ${c.all_steps_done ? 'yes' : 'no '}  served by ${c.served_by.join(', ') || 'nothing'}`);
  if (result.status === 'held') {
    const failed = result.steps.at(-1)?.id;
    console.log(`\nHeld for the operator. To continue from the failed step: node scripts/run.ts ${id} --from ${failed}`);
  }
  process.exitCode = result.status === 'completed' ? 0 : 1;
}

main().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
