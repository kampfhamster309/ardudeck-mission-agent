#!/usr/bin/env node
// Mission planning from the command line (until the Ardudeck panel exists).
//
//   node scripts/plan.ts new <id> "<mission request>"     draft + validate
//   node scripts/plan.ts show <id>
//   node scripts/plan.ts answer <id> <qN> "<answer>"
//   node scripts/plan.ts edit <id> <slot> "<prose>"        operator writes a section
//   node scripts/plan.ts waive <id> <finding> "<reason>"   operator accepts a finding (until the next validation)
//   node scripts/plan.ts provide <id> "<need text>" "<how>"  operator: a configuration need is met (and how)
//   node scripts/plan.ts restore <id> <round>              back to an earlier round's snapshot (rounds/round-N.json)
//   node scripts/plan.ts update <id>                       planner works answers/findings in, validate
//   node scripts/plan.ts refine <id> <slot> "<brief>"      planner reworks one section, validate
//   node scripts/plan.ts validate <id> [--no-llm]
//   node scripts/plan.ts approve <id>
//   node scripts/plan.ts compile <id>                      approved plan -> spec.yaml + spec.md, or blockers
//   node scripts/plan.ts operator <id> <facts.md>          simulated operator answers open questions
//   node scripts/plan.ts design <id>                       design missing attachments with SolidCraft
//   node scripts/plan.ts design-replay <id> [slug]         rebuild a design from its transcript (no LLM), e.g. in the app
//      (SOLIDCRAFT_CONNECT=127.0.0.1:7878 drives the app started with `solidcraft --control 7878`)
//   node scripts/plan.ts fit <id> <design.json>            operator: the addon is fitted (updates MISSION_CAPS)
//
// Env: MISSION_LLM_URL, MISSION_LLM_MODEL (OpenAI-compatible), optional MISSION_LLM_KEY, MISSION_LLM_MAX_TOKENS,
//      MISSION_CAPS (default ../rover/capabilities.yaml), MISSION_SITES (default ../rover/sites.yaml),
//      MISSION_DIR (default ../missions), all relative to this repo; MISSION_LLM_CONTEXT (context
//      window for the token log, default 1000000). Token use per request: <mission>/usage.jsonl.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { answerQuestion, approve, provideNeed, waiveFinding, newPlan, renderMarkdown, requestRefine, setProse, type MissionPlan } from '../src/planning/plan.ts';
import { runPlannerRound, runValidation, type Context } from '../src/planning/agents.ts';
import { formatTotals, llmConfigFromEnv, openAiChat, UsageMeter } from '../src/planning/llm.ts';
import { compileSpec, renderSpecMarkdown, type SitesFile } from '../src/planning/spec.ts';
import { stringify as toYaml } from 'yaml';
import { simulatedOperator } from '../src/planning/operator.ts';
import { addonSlug, designAddon, designDiscrepancies, finishDesign, leadingJson, missingAttachments, replayDesign, type AddonDesign } from '../src/planning/designer.ts';
import { McpStdioClient } from '../src/planning/mcp.ts';

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
  mkdirSync(join(missionDir, plan.id, 'rounds'), { recursive: true });
  writeFileSync(planFile(plan.id), JSON.stringify(plan, null, 2) + '\n');
  // one snapshot per round (the last save of the round wins), so a good round can be restored
  writeFileSync(join(missionDir, plan.id, 'rounds', `round-${plan.round}.json`), JSON.stringify(plan, null, 2) + '\n');
  writeFileSync(join(missionDir, plan.id, 'plan.md'), renderMarkdown(plan));
}

function saveTranscript(plan: MissionPlan, name: string, transcript: unknown) {
  const dir = join(missionDir, plan.id, 'transcripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(transcript, null, 1) + '\n');
}

const log = (s: string) => process.stderr.write(s + '\n');

/**
 * SolidCraft's MCP server. SOLIDCRAFT_CONNECT=host:port drives the running app (started with
 * `solidcraft --control PORT`), so the operator watches the part being built; without it the
 * server bridges to the app only if it finds it, else it builds headless (and says so).
 */
async function solidcraft(allowDir: string): Promise<McpStdioClient> {
  const connect = process.env['SOLIDCRAFT_CONNECT'];
  mkdirSync(allowDir, { recursive: true });
  // --allow-path: exports and saves go to the mission's addons folder
  const mcp = new McpStdioClient(process.env['SOLIDCRAFT_CMD'] ?? 'solidcraft-cli', ['mcp', '--allow-path', allowDir, ...(connect ? ['--connect', connect] : [])]);
  await mcp.start();
  const v = leadingJson(await mcp.callTool('version', {})) as { mode?: string };
  log(`SolidCraft: ${v.mode ?? 'unknown mode'}${connect ? ` (${connect})` : ''}`);
  if (v.mode === 'headless') log('  note: headless, the SolidCraft window won\'t show this design (set SOLIDCRAFT_CONNECT and start the app with --control)');
  return mcp;
}

function printDesign(d: AddonDesign) {
  const issues = designDiscrepancies(d);
  console.log(`${d.name}: measured ${d.measured.size_mm.join(' x ')} mm, ${d.measured.volume_mm3} mm³`);
  for (const p of d.measured.parts ?? []) console.log(`  part ${p.name}: ${p.size_mm.join(' x ')} mm, ${p.volume_mm3} mm³`);
  console.log(`  functional: ${JSON.stringify(d.functional)}`);
  console.log(`  blocks: ${JSON.stringify(d.blocks)}`);
  console.log(`  files: ${d.files.join(', ')}`);
  if (issues.length) console.log(`  CHECK: ${issues.join('; ')}`);
}

/** Token use: every request goes to <mission>/usage.jsonl; each step prints its totals. */
let meter = new UsageMeter();
function chatFor(id: string) {
  meter = new UsageMeter(join(missionDir, id, 'usage.jsonl'));
  return openAiChat(llmConfigFromEnv(), log, meter.record);
}
function step(label: string) {
  meter.start(label);
}
function stepDone() {
  if (meter.totals.requests) log(`  ${meter.label}: ${formatTotals(meter.totals)}`);
}

async function plannerThenValidate(plan: MissionPlan) {
  const chat = chatFor(plan.id);
  const ctx = context();
  log(`planner, round ${plan.round + 1}:`);
  step(`planner round ${plan.round + 1}`);
  const t0 = Date.now();
  const r = await runPlannerRound(plan, ctx, chat, log);
  stepDone();
  saveTranscript(plan, `planner-round-${plan.round}`, r.transcript);
  log(`  -> ${r.finished ? 'done' : 'stopped without done'} after ${r.steps} steps, ${r.toolCalls} tool calls, ${((Date.now() - t0) / 1000).toFixed(0)} s${r.summary ? `: ${r.summary}` : ''}`);
  save(plan);
  log('validator:');
  step(`validator round ${plan.round}`);
  const t1 = Date.now();
  const f = await runValidation(plan, ctx, chat, log, (t) => saveTranscript(plan, `validator-round-${plan.round}`, t));
  stepDone();
  log(`  -> ${f.length} findings (${f.filter((x) => x.severity === 'error').length} errors), ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  save(plan);
}

async function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);
  if (!cmd || (!id && cmd !== 'help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(1, 17).join('\n').replace(/^\/\/ ?/gm, ''));
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
    case 'waive': {
      const plan = load(id!);
      const f = waiveFinding(plan, rest[0]!, rest.slice(1).join(' '));
      save(plan);
      console.log(`waived ${f.id} (${f.severity}): ${f.text.slice(0, 120)}`);
      break;
    }
    case 'provide': {
      const plan = load(id!);
      const wasApproved = plan.status === 'approved';
      const c = provideNeed(plan, rest[0]!, rest.slice(1).join(' '));
      save(plan);
      console.log(`provided: ${c.need}${wasApproved ? ' (the plan is a draft again: approve it again)' : ''}`);
      break;
    }
    case 'restore': {
      // go back to the snapshot of an earlier round
      const plan = load(id!);
      const snap = join(missionDir, plan.id, 'rounds', `round-${rest[0]}.json`);
      const old = JSON.parse(readFileSync(snap, 'utf-8')) as MissionPlan;
      old.history.push({ at: new Date().toISOString(), by: 'operator', action: `restored round ${rest[0]} (was round ${plan.round})` });
      save(old);
      console.log(`restored ${plan.id} to round ${rest[0]}`);
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
      step(`validator round ${plan.round}`);
      await runValidation(plan, context(), useLlm ? chatFor(plan.id) : null, log, (t) => saveTranscript(plan, `validator-round-${plan.round}`, t));
      stepDone();
      save(plan);
      console.log(renderMarkdown(plan));
      break;
    }
    case 'compile': {
      const plan = load(id!);
      const ctx = context();
      const r = compileSpec(plan, ctx.capabilities, ctx.sites as SitesFile);
      if (!r.ok) {
        console.log(`can't compile ${id} yet:\n- ${r.blockers.join('\n- ')}`);
        process.exitCode = 2;
        break;
      }
      writeFileSync(join(missionDir, plan.id, 'spec.yaml'), toYaml(r.spec, { lineWidth: 100 }));
      writeFileSync(join(missionDir, plan.id, 'spec.md'), renderSpecMarkdown(r.spec));
      console.log(renderSpecMarkdown(r.spec));
      log(`wrote ${join(missionDir, plan.id, 'spec.yaml')} and spec.md`);
      break;
    }
    case 'operator': {
      const plan = load(id!);
      const facts = readFileSync(resolve(rest[0] ?? ''), 'utf-8');
      const chat = chatFor(plan.id);
      step('simulated operator');
      const n = await simulatedOperator(plan, facts, chat, log);
      stepDone();
      save(plan);
      for (const q of plan.questions) console.log(`${q.id}: ${q.question}\n  -> ${q.answer?.text ?? '(open)'}`);
      log(`answered ${n} question(s)`);
      break;
    }
    case 'design': {
      const plan = load(id!);
      const needs = missingAttachments(plan);
      if (!needs.length) { console.log('the plan needs no attachment'); break; }
      const mcp = await solidcraft(join(missionDir, plan.id, 'addons'));
      try {
        for (const item of needs) {
          log(`designing "${item.need}":`);
          const t0 = Date.now();
          const build = chatFor(plan.id);
          // phase 1 thinks once, long: give it room (MISSION_DESIGN_PLAN_MAX_TOKENS, default 65536) at
          // effort MISSION_DESIGN_PLAN_EFFORT (default high: at xhigh the model can think through all 65k
          // without answering; if it runs out anyway, the chat retries one effort lower, down to medium)
          const planChat = openAiChat({
            ...llmConfigFromEnv(),
            maxTokens: Number(process.env['MISSION_DESIGN_PLAN_MAX_TOKENS'] ?? 65_536),
            reasoningEffort: process.env['MISSION_DESIGN_PLAN_EFFORT'] ?? 'high',
          }, log, meter.record);
          step(`designer: ${item.need.slice(0, 40)}`);
          const d = await designAddon(plan, item, context().capabilities as Record<string, any>, { plan: planChat, build }, mcp, join(missionDir, plan.id, 'addons'), log);
          stepDone();
          if ('error' in d) { console.log(`design failed: ${d.error}`); process.exitCode = 1; continue; }
          log(`  designed in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
          printDesign(d);
        }
      } finally {
        mcp.close();
      }
      break;
    }
    case 'design-replay': {
      // rebuild a design from its phase-2 transcript, without the LLM (e.g. in the visible app)
      const plan = load(id!);
      const slug = rest[0] ?? 'front_plow';
      const outDir = join(missionDir, plan.id, 'addons');
      const transcript = JSON.parse(readFileSync(join(outDir, `${slug}.transcript.json`), 'utf-8'));
      const item = missingAttachments(plan).find((x) => addonSlug(x.need) === slug);
      const mcp = await solidcraft(outDir);
      try {
        const r = await replayDesign(transcript, slug, mcp, log);
        log(`replayed ${r.calls} call(s), ${r.errors} failed`);
        if (!r.submitted) { console.log('the transcript has no submitted design'); process.exitCode = 1; break; }
        const d = await finishDesign(r.submitted, item?.need ?? slug, mcp, outDir, slug, log);
        printDesign(d);
      } finally {
        mcp.close();
      }
      break;
    }
    case 'fit': {
      const d = JSON.parse(readFileSync(resolve(rest[0] ?? ''), 'utf-8')) as AddonDesign;
      const text = readFileSync(capsPath, 'utf-8');
      const header = text.split('\n').filter((l, i, all) => l.startsWith('#') && all.slice(0, i).every((x) => x.startsWith('#'))).join('\n');
      const caps = parseYaml(text) as Record<string, any>;
      caps['attachments'] = (caps['attachments'] ?? []).filter((a: { name?: string }) => a.name !== d.name);
      caps['attachments'].push({
        name: d.name,
        fitted: true,
        status: 'verified',
        source: `operator confirmed fitting ${new Date().toISOString().slice(0, 10)} (design ${d.designed_at})`,
        purpose: d.need,
        design: d.files,
        functional: d.functional,
        measured_size_mm: { x: d.measured.size_mm[0], y: d.measured.size_mm[1], z: d.measured.size_mm[2] },
        footprint_change_mm: { front: Math.round(d.measured.bbox_max[0]!) },
        mount: d.mount,
        blocks: d.blocks,
        enables: ['push_to'],
      });
      writeFileSync(capsPath, `${header}\n${toYaml(caps, { lineWidth: 110 })}`);
      console.log(`fitted ${d.name} in ${capsPath}; run "update ${id}" so the planner takes it into account`);
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
