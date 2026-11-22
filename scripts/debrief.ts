#!/usr/bin/env node
// Debrief a mission run into the experience vault (see src/vault/debrief.ts).
//
//   node scripts/debrief.ts <mission> [run] [--env sim|real] [--world http://127.0.0.1:8766]
//                           [--note "operator remarks"] [--no-commit]
//
// run: a folder under missions/<mission>/runs (default: the latest). --world fetches the
// simulator's ground truth (sim-world's /world). --env defaults to sim when MISSION_CAPS points
// into a sim/ folder or --world is given, else real. The vault is MISSION_VAULT or
// ~/vaults/jetrover; the debrief commits what it wrote there unless --no-commit.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTotals, llmConfigFromEnv, openAiChat, UsageMeter } from '../src/planning/llm.ts';
import { runDebrief } from '../src/vault/debrief.ts';
import { vaultDir } from '../src/vault/vault.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const missionDir = resolve(repo, process.env['MISSION_DIR'] ?? '../missions');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const withValue = new Set(['--env', '--world', '--note']);
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && withValue.has(all[i - 1]!)));
  const [mission, runArg] = positional;
  if (!mission) { console.log('usage: node scripts/debrief.ts <mission> [run] [--env sim|real] [--world URL] [--note TEXT] [--no-commit]'); process.exitCode = 2; return; }
  const vault = vaultDir();
  if (!vault) { console.log('no experience vault (MISSION_VAULT, or ~/vaults/jetrover with a VAULT-INDEX.md)'); process.exitCode = 2; return; }
  const dir = join(missionDir, mission);
  const runs = readdirSync(join(dir, 'runs')).sort();
  const run = runArg ?? runs.at(-1);
  if (!run || !existsSync(join(dir, 'runs', run, 'events.jsonl'))) { console.log(`no run "${run}" in ${join(dir, 'runs')}`); process.exitCode = 2; return; }
  const runDir = join(dir, 'runs', run);

  const world = arg('--world');
  let groundTruth: string | undefined;
  if (world) {
    const res = await fetch(`${world.replace(/\/$/, '')}/world`);
    groundTruth = JSON.stringify(await res.json(), null, 1);
  }
  const env = (arg('--env') ?? (world || /[\\/]sim[\\/]/.test(process.env['MISSION_CAPS'] ?? '') ? 'sim' : 'real')) as 'sim' | 'real';

  // a resumed run (--from) continues earlier ones of the same plan: give the debrief the chain
  type Res = { from?: string; plan_hash?: string };
  const result = readFileSync(join(runDir, 'result.json'), 'utf-8');
  const chain: string[] = [];
  const me = JSON.parse(result) as Res;
  if (me.from) {
    for (let i = runs.indexOf(run) - 1; i >= 0; i--) {
      const f = join(dir, 'runs', runs[i]!, 'result.json');
      if (!existsSync(f)) continue;
      const r = JSON.parse(readFileSync(f, 'utf-8')) as Res;
      if (r.plan_hash && me.plan_hash && r.plan_hash !== me.plan_hash) break;
      chain.unshift(runs[i]!);
      if (!r.from) break;
    }
  }
  const events = [...chain, run].map((r) => `# run ${r}\n${readFileSync(join(dir, 'runs', r, 'events.jsonl'), 'utf-8')}`).join('\n');

  const meter = new UsageMeter(join(runDir, 'usage.jsonl'));
  meter.start('debrief');
  const log = (s: string) => console.error(s);
  const chat = openAiChat(llmConfigFromEnv(), log, meter.record);
  const system = readFileSync(join(repo, 'prompts', 'debrief.md'), 'utf-8');
  const out = await runDebrief(vault, {
    mission, run, environment: env, date: run.slice(0, 10),
    spec: readFileSync(join(dir, 'spec.md'), 'utf-8'), events, result, groundTruth, operatorNote: arg('--note'),
  }, chat, system, log);

  console.log(`run report: ${out.report ?? '(none written)'}`);
  for (const p of out.proposals) console.log(`proposed:   ${p}`);
  console.log(`LLM: ${formatTotals(out.usage)}`);
  if (!process.argv.includes('--no-commit') && existsSync(join(vault, '.git')) && (out.report || out.proposals.length)) {
    execFileSync('git', ['add', '-A', 'Runs', 'Proposals', 'Rover', 'Behaviours', 'Sites', 'Strategy'].filter((p, i) => i < 2 || existsSync(join(vault, p))), { cwd: vault });
    execFileSync('git', ['commit', '-q', '-m', `debrief ${mission} ${run}: ${out.proposals.length} proposal(s)`], { cwd: vault });
    console.log(`committed in ${vault}; accept lessons in Obsidian by setting status: active`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
