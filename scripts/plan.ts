#!/usr/bin/env node
// Mission planning from the command line (until the Ardudeck panel exists).
//
//   node scripts/plan.ts new <id> "<mission request>"     draft + validate
//   node scripts/plan.ts show <id>
//   node scripts/plan.ts answer <id> <qN> "<answer>"
//   node scripts/plan.ts edit <id> <slot> "<prose>"        operator writes a section
//   node scripts/plan.ts update <id>                       planner works answers/findings in, validate
//   node scripts/plan.ts refine <id> <slot> "<brief>"      planner reworks one section, validate
//   node scripts/plan.ts validate <id> [--no-llm]
//   node scripts/plan.ts approve <id>
//
// Env: MISSION_LLM_URL, MISSION_LLM_MODEL (OpenAI-compatible), optional MISSION_LLM_KEY, MISSION_LLM_MAX_TOKENS,
//      MISSION_CAPS (default ../rover/capabilities.yaml), MISSION_SITES (default ../rover/sites.yaml),
//      MISSION_DIR (default ../missions), all relative to this repo.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { answerQuestion, approve, newPlan, renderMarkdown, requestRefine, setProse, type MissionPlan } from '../src/planning/plan.ts';
import { runPlannerRound, runValidation, type Context } from '../src/planning/agents.ts';
import { llmConfigFromEnv, openAiChat } from '../src/planning/llm.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const capsPath = resolve(repo, process.env['MISSION_CAPS'] ?? '../rover/capabilities.yaml');
const sitesPath = resolve(repo, process.env['MISSION_SITES'] ?? '../rover/sites.yaml');
const missionDir = resolve(repo, process.env['MISSION_DIR'] ?? '../missions');

function context(): Context {
  const capabilitiesText = readFileSync(capsPath, 'utf-8');
  const sitesText = existsSync(sitesPath) ? readFileSync(sitesPath, 'utf-8') : '';
  return {
    capabilitiesText, sitesText,
    capabilities: parseYaml(capabilitiesText) as Record<string, unknown>,
    sites: (sitesText ? parseYaml(sitesText) : {}) as Record<string, unknown>,
  };
}

const planFile = (id: string) => join(missionDir, id, 'plan.json');

function load(id: string): MissionPlan {
  if (!existsSync(planFile(id))) throw new Error(`no mission "${id}" in ${missionDir}`);
  return JSON.parse(readFileSync(planFile(id), 'utf-8')) as MissionPlan;
}

function save(plan: MissionPlan): void {
  mkdirSync(join(missionDir, plan.id), { recursive: true });
  writeFileSync(planFile(plan.id), JSON.stringify(plan, null, 2) + '\n');
  writeFileSync(join(missionDir, plan.id, 'plan.md'), renderMarkdown(plan));
}

function saveTranscript(plan: MissionPlan, name: string, transcript: unknown) {
  const dir = join(missionDir, plan.id, 'transcripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(transcript, null, 1) + '\n');
}

const log = (s: string) => process.stderr.write(s + '\n');

async function plannerThenValidate(plan: MissionPlan) {
  const chat = openAiChat(llmConfigFromEnv(), log);
  const ctx = context();
  log(`planner, round ${plan.round + 1}:`);
  const t0 = Date.now();
  const r = await runPlannerRound(plan, ctx, chat, log);
  saveTranscript(plan, `planner-round-${plan.round}`, r.transcript);
  log(`  -> ${r.finished ? 'done' : 'stopped without done'} after ${r.steps} steps, ${r.toolCalls} tool calls, ${((Date.now() - t0) / 1000).toFixed(0)} s${r.summary ? `: ${r.summary}` : ''}`);
  save(plan);
  log('validator:');
  const t1 = Date.now();
  const f = await runValidation(plan, ctx, chat, log, (t) => saveTranscript(plan, `validator-round-${plan.round}`, t));
  log(`  -> ${f.length} findings (${f.filter((x) => x.severity === 'error').length} errors), ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  save(plan);
}

async function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);
  if (!cmd || (!id && cmd !== 'help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(1, 13).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }
  switch (cmd) {
    case 'new': {
      if (existsSync(planFile(id!))) throw new Error(`mission "${id}" exists already`);
      const request = rest.join(' ').trim();
      if (!request) throw new Error('give the mission request');
      const plan = newPlan(id!, request);
      save(plan);
      await plannerThenValidate(plan);
      console.log(renderMarkdown(plan));
      break;
    }
    case 'show':
      console.log(renderMarkdown(load(id!)));
      break;
    case 'answer': {
      const plan = load(id!);
      answerQuestion(plan, rest[0]!, rest.slice(1).join(' '));
      save(plan);
      console.log(`answered ${rest[0]}; run "update ${id}" to have the planner work it in`);
      break;
    }
    case 'edit': {
      const plan = load(id!);
      setProse(plan, rest[0]!, rest.slice(1).join(' '), 'operator');
      save(plan);
      console.log(`set ${rest[0]}`);
      break;
    }
    case 'update': {
      const plan = load(id!);
      await plannerThenValidate(plan);
      console.log(renderMarkdown(plan));
      break;
    }
    case 'refine': {
      const plan = load(id!);
      requestRefine(plan, rest[0]!, rest.slice(1).join(' '));
      await plannerThenValidate(plan);
      console.log(renderMarkdown(plan));
      break;
    }
    case 'validate': {
      const plan = load(id!);
      const useLlm = !rest.includes('--no-llm');
      await runValidation(plan, context(), useLlm ? openAiChat(llmConfigFromEnv(), log) : null, log, (t) => saveTranscript(plan, `validator-round-${plan.round}`, t));
      save(plan);
      console.log(renderMarkdown(plan));
      break;
    }
    case 'approve': {
      const plan = load(id!);
      approve(plan);
      save(plan);
      console.log(`approved ${id}`);
      break;
    }
    default:
      throw new Error(`unknown command "${cmd}"`);
  }
}

main().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
