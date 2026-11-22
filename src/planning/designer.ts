// Addon design: the agent designs an attachment the plan needs, with the SolidCraft MCP tools.
// Code then measures what was actually built, exports it and records it, so the rest of the
// pipeline (fitting, the simulation's plow physics) uses measured numbers, not claims.

import { mkdirSync, writeFileSync } from 'node:fs';
import { loadPrompt } from './prompts.ts';
import { join } from 'node:path';
import { toolLoop, type ChatFn, type ToolDef } from './llm.ts';
import type { McpStdioClient } from './mcp.ts';
import type { ConfigItem, MissionPlan } from './plan.ts';

export interface AddonDesign {
  name: string;
  need: string;
  /** what the designer reports it built */
  functional: { mouth_width_mm?: number; mouth_depth_mm?: number; wall_height_mm?: number; edge_height_mm?: number; [k: string]: unknown };
  overall_mm: { x: number; y: number; z: number };
  blocks: { lidar_sectors_deg?: number[][]; camera?: string; ferret?: string };
  mount: string;
  notes: string;
  /** what SolidCraft measured */
  measured: {
    bbox_min: number[]; bbox_max: number[]; size_mm: number[]; volume_mm3: number; bodies: number;
    /** each body is one printed part */
    parts?: Array<{ name: string; size_mm: number[]; volume_mm3: number }>;
  };
  files: string[];
  designed_at: string;
}

/**
 * Attachments the plan says are missing. Default: items that name a known kind of add-on (plow,
 * scoop, bracket ...). With MISSION_ATTACHMENTS=neutral: every missing item nothing on the rover
 * provides (provided_by null or attachments.*); the designer declines what isn't a part.
 */
export function missingAttachments(plan: MissionPlan, mode = process.env['MISSION_ATTACHMENTS'] ?? 'keywords'): ConfigItem[] {
  const items = (plan.sections.configuration.items ?? []) as ConfigItem[];
  if (mode === 'neutral') return items.filter((c) => c.status === 'missing' && (!c.provided_by || /^attachments/.test(c.provided_by)));
  return items.filter((c) => c.status === 'missing' && /plow|plough|scoop|blade|attachment|bracket|guide|funnel/i.test(`${c.need} ${c.provided_by ?? ''}`));
}

/** File-name slug for an add-on, from the words of the need. */
export function addonSlug(need: string): string {
  const known = need.toLowerCase().match(/plow|plough|scoop|blade|bracket|guide|funnel/)?.[0];
  if (known) return `front_${known.replace('plough', 'plow')}`;
  return need.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').split('_').slice(0, 4).join('_') || 'addon';
}

function briefFor(plan: MissionPlan, item: ConfigItem, caps: Record<string, any>): string {
  const ch = caps['chassis'] ?? {};
  const v = (x: any) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
  const answers = plan.questions.filter((q) => q.answer).map((q) => `- ${q.question} → ${q.answer!.text}`).join('\n');
  return [
    `## Brief from mission plan "${plan.id}"`,
    '',
    `Mission: ${plan.request}`,
    '',
    `Needed: **${item.need}**`,
    item.note ? `Plan's note: ${item.note}` : '',
    '',
    'What the plan says about the rover configuration:',
    plan.sections.configuration.prose,
    '',
    '## The rover',
    `- footprint: ${v(ch.footprint_length_mm)} mm long, ${v(ch.footprint_width_mm)} mm wide; ground clearance ${v(ch.ground_clearance_mm)} mm`,
    `- front mount: ${v(ch.front_mount)}`,
    `- LiDAR (LD19): 360° horizontal scan plane ${v(caps['sensors']?.lidar_ld19?.mount_height_mm)} mm above the ground`,
    `- camera (C270): ${v(caps['sensors']?.camera_c270?.mount_height_mm)} mm above the ground, looking straight ahead, 45° horizontal; sees from about 0.5 m ahead`,
    `- depth camera (Ferret): ${v(caps['sensors']?.depth_ferret_pro?.mount)}`,
    '',
    answers ? `## Settled answers from the operator\n${answers}` : '',
  ].filter((l) => l !== '').join('\n');
}

/** Phase 1's result: the geometry, decided once. */
export interface ConstructionPlan {
  key_numbers: Record<string, unknown>;
  stages: Array<{ name: string; build: string; expect: string }>;
  blocks_expected?: Record<string, unknown>;
  notes?: string;
}

/**
 * Two phases, both with thinking:
 *  1. plan: decide the geometry once (one long think, `chats.plan`), as a construction plan;
 *  2. build: model the plan stage by stage in SolidCraft (`chats.build`), measuring and looking
 *     at each stage. Splitting them keeps the model from re-planning the whole part before every
 *     tool call.
 */
export async function designAddon(
  plan: MissionPlan, item: ConfigItem, caps: Record<string, any>, chats: { plan: ChatFn; build: ChatFn }, mcp: McpStdioClient, outDir: string,
  log: (s: string) => void = () => {},
): Promise<AddonDesign | { error: string; declined?: boolean }> {
  const slug = addonSlug(item.need);
  mkdirSync(outDir, { recursive: true });
  const brief = briefFor(plan, item, caps);

  // --- phase 1: construction plan -------------------------------------------------------
  const guide = await mcp.callTool('skill_reference', { skill: 'solidcraft-modeling' });
  const p1: { plan: ConstructionPlan | null; declined: string | null } = { plan: null, declined: null };
  log('  phase 1: construction plan');
  const r1 = await toolLoop(chats.plan, `${loadPrompt('designer-plan')}\n\n## SolidCraft modelling guide (for planning)\n\n${guide}`,
    `${brief}\n\nDecide the geometry, then call submit_construction_plan.`, [
      {
        name: 'not_a_part',
        description: 'Decline: this need is not something to design and print (say what it is instead).',
        terminal: true,
        parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
        run: (a) => { p1.declined = String(a['reason'] ?? ''); return 'noted'; },
      },
      {
        name: 'submit_construction_plan',
        description: 'Submit the decided geometry: key numbers and the build stages (once).',
        terminal: true,
        parameters: {
          type: 'object',
          properties: {
            key_numbers: { type: 'object', description: 'every functional and mount dimension in mm, each with its reason' },
            stages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  build: { type: 'string', description: 'what to build with which SolidCraft operations, every dimension and position as a number' },
                  expect: { type: 'string', description: 'what measure should show after this stage' },
                },
                required: ['name', 'build', 'expect'],
              },
            },
            blocks_expected: { type: 'object' },
            notes: { type: 'string' },
          },
          required: ['key_numbers', 'stages'],
        },
        run: (a) => {
          const parse = (x: unknown) => (typeof x === 'string' ? JSON.parse(x) : x);
          const stages = parse(a['stages']) as ConstructionPlan['stages'];
          if (!Array.isArray(stages) || !stages.length) throw new Error('stages must be a non-empty list');
          p1.plan = { key_numbers: parse(a['key_numbers']) as Record<string, unknown>, stages, blocks_expected: parse(a['blocks_expected']) as Record<string, unknown>, notes: String(a['notes'] ?? '') };
          return 'received';
        },
      },
    ], { log, maxSteps: 4 });
  writeFileSync(join(outDir, `${slug}.plan-transcript.json`), JSON.stringify(r1.transcript, null, 1) + '\n');
  if (p1.declined) return { error: `not a part: ${p1.declined}`, declined: true };
  if (!p1.plan) return { error: `phase 1 stopped without a construction plan (${r1.steps} steps)` };
  const construction: ConstructionPlan = p1.plan;
  writeFileSync(join(outDir, `${slug}.construction.json`), JSON.stringify(construction, null, 2) + '\n');
  log(`  construction plan: ${construction.stages.map((st) => st.name).join(' -> ')}`);

  // --- phase 2: build -------------------------------------------------------------------
  await mcp.callTool('new_design', { name: slug });
  const box: { submitted: SubmittedDesign | null } = { submitted: null };
  const tools: ToolDef[] = [
    ...(await mcp.asToolDefs((process.env['MISSION_DESIGNER_VISION'] ?? '1') === '0'
      ? ['screenshot', 'compare_picture', 'open', 'save', 'export', 'crash_reports']
      : ['compare_picture', 'open', 'save', 'export', 'crash_reports'])),
    {
      name: 'submit_design',
      description: 'Submit the finished, checked design (once).',
      terminal: true,
      parameters: {
        type: 'object',
        properties: {
          functional: { type: 'object', description: 'functional dimensions in mm as built' },
          overall_mm: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
          blocks: { type: 'object', description: '{lidar_sectors_deg: [[from, to], ...], camera: "...", ferret: "..."}' },
          mount: { type: 'string', description: 'how it attaches to the front mount' },
          notes: { type: 'string', description: 'anything changed from the construction plan, and why' },
        },
        required: ['functional', 'overall_mm', 'blocks', 'mount'],
      },
      run: (a) => {
        const parse = (x: unknown) => (typeof x === 'string' ? JSON.parse(x) : x);
        box.submitted = {
          name: slug,
          functional: parse(a['functional']) as AddonDesign['functional'],
          overall_mm: parse(a['overall_mm']) as AddonDesign['overall_mm'],
          blocks: parse(a['blocks']) as AddonDesign['blocks'],
          mount: String(a['mount'] ?? ''),
          notes: String(a['notes'] ?? ''),
        };
        return 'received';
      },
    },
  ];
  log('  phase 2: build');
  const system = `${loadPrompt('designer-build')}\n\n## SolidCraft's instructions\n\n${mcp.instructions}\n\n## SolidCraft modelling guide\n\n${guide}`;
  const user = `${brief}\n\n## Construction plan (decided; build this)\n\n${JSON.stringify(construction, null, 2)}\n\nBuild it stage by stage, check each stage, then call submit_design.`;
  const result = await toolLoop(chats.build, system, user, tools, { log, maxSteps: 120 });
  writeFileSync(join(outDir, `${slug}.transcript.json`), JSON.stringify(result.transcript, null, 1) + '\n');
  const sub = box.submitted;
  if (!sub) return { error: `phase 2 stopped without submitting a design (${result.steps} steps)` };
  return finishDesign(sub, item.need, mcp, outDir, slug, log);
}

/** The JSON value at the start of a tool's text (SolidCraft can append a note after it). */
export function leadingJson(text: string): unknown {
  const t = text.trimStart();
  const open = t[0];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return JSON.parse(t);
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(t.slice(0, i + 1));
  }
  return JSON.parse(t);
}

export type SubmittedDesign = Omit<AddonDesign, 'measured' | 'files' | 'designed_at' | 'need'>;

/** Measure the design open in SolidCraft, export STEP/STL, save the .sc and write <slug>.json. */
export async function finishDesign(sub: SubmittedDesign, need: string, mcp: McpStdioClient, outDir: string, slug: string, log: (s: string) => void = () => {}): Promise<AddonDesign> {
  const m = leadingJson(await mcp.callTool('measure', { summary: true })) as {
    bodies: Array<{ name: string; volume_mm3: number; bbox: { min: number[]; max: number[] } }>;
    total?: { volume_mm3?: number };
  };
  if (!m.bodies?.length) throw new Error('the design has no bodies');
  const min = [0, 1, 2].map((i) => Math.min(...m.bodies.map((b) => b.bbox.min[i]!)));
  const max = [0, 1, 2].map((i) => Math.max(...m.bodies.map((b) => b.bbox.max[i]!)));
  const size = [0, 1, 2].map((i) => +(max[i]! - min[i]!).toFixed(1));
  const volume = m.total?.volume_mm3 ?? m.bodies.reduce((s, b) => s + b.volume_mm3, 0);

  const files: string[] = [];
  for (const ext of ['step', 'stl']) {
    const path = join(outDir, `${slug}.${ext}`);
    try { await mcp.callTool('export', { path }); files.push(path); } catch (err) { log(`  export ${ext} failed: ${(err as Error).message.slice(0, 200)}`); }
  }
  try {
    const path = join(outDir, `${slug}.sc`);
    await mcp.callTool('save', { path });
    files.push(path);
  } catch (err) { log(`  save failed: ${(err as Error).message.slice(0, 200)}`); }

  const design: AddonDesign = {
    ...sub, need,
    measured: {
      bbox_min: min, bbox_max: max, size_mm: size, volume_mm3: Math.round(volume), bodies: m.bodies.length,
      parts: m.bodies.map((b) => ({ name: b.name, size_mm: [0, 1, 2].map((i) => +(b.bbox.max[i]! - b.bbox.min[i]!).toFixed(1)), volume_mm3: Math.round(b.volume_mm3) })),
    },
    files, designed_at: new Date().toISOString(),
  };
  writeFileSync(join(outDir, `${slug}.json`), JSON.stringify(design, null, 2) + '\n');
  return design;
}

/** The printer's build volume in mm (MISSION_PRINT_BED_MM, e.g. "220x220x250"). */
export function printBed(env = process.env): number[] {
  const v = (env['MISSION_PRINT_BED_MM'] ?? '220x220x250').split(/[x×, ]+/).map(Number);
  return v.length === 3 && v.every((n) => n > 0) ? v : [220, 220, 250];
}

/**
 * Mismatches between what the designer claims and what was measured (mm), and parts that don't
 * fit the print bed in any axis-aligned orientation. Several bodies are fine: each is a part.
 */
export function designDiscrepancies(d: AddonDesign, tolMm = 3, bed = printBed()): string[] {
  const out: string[] = [];
  const claim = d.overall_mm;
  (['x', 'y', 'z'] as const).forEach((axis, i) => {
    const said = claim[axis];
    const size = d.measured.size_mm[i]!;
    const top = d.measured.bbox_max[i]!; // a height may be given from the ground, not as the extent
    if (typeof said === 'number' && Math.abs(size - said) > tolMm && !(axis === 'z' && Math.abs(top - said) <= tolMm)) {
      out.push(`overall ${axis}: claimed ${said} mm, measured ${size} mm`);
    }
  });
  const bedSorted = [...bed].sort((a, b) => a - b);
  for (const p of d.measured.parts ?? []) {
    const s = [...p.size_mm].sort((a, b) => a - b);
    if (s.some((v, i) => v > bedSorted[i]!)) out.push(`part ${p.name} (${p.size_mm.join(' x ')} mm) doesn't fit the ${bed.join(' x ')} mm print bed`);
  }
  return out;
}

/** Tools whose calls change nothing in the design: skipped when replaying a build. */
const READ_ONLY_TOOLS = new Set(['skill_reference', 'describe_command', 'list_commands', 'screenshot', 'measure', 'body_topology', 'inspect_design', 'version', 'running', 'pending', 'compare_picture', 'crash_reports']);

/**
 * Rebuild a design from a phase-2 transcript: the same SolidCraft calls in the same order on a
 * new design (e.g. after a headless session was lost, or to show it in the app). Calls that
 * failed in the original fail again and change nothing. Returns the submitted design, if any.
 */
export async function replayDesign(transcript: Array<{ role: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>, slug: string, mcp: McpStdioClient, log: (s: string) => void = () => {}): Promise<{ submitted: SubmittedDesign | null; calls: number; errors: number }> {
  await mcp.callTool('new_design', { name: slug });
  let calls = 0;
  let errors = 0;
  let submitted: SubmittedDesign | null = null;
  const parse = (x: unknown) => (typeof x === 'string' ? JSON.parse(x) : x);
  for (const m of transcript) {
    for (const c of m.tool_calls ?? []) {
      const name = c.function.name;
      const args = c.function.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
      if (name === 'submit_design') {
        submitted = {
          name: slug,
          functional: parse(args['functional']) as AddonDesign['functional'],
          overall_mm: parse(args['overall_mm']) as AddonDesign['overall_mm'],
          blocks: parse(args['blocks']) as AddonDesign['blocks'],
          mount: String(args['mount'] ?? ''),
          notes: String(args['notes'] ?? ''),
        };
        continue;
      }
      if (READ_ONLY_TOOLS.has(name)) continue;
      calls++;
      try {
        await mcp.callTool(name, args);
        log(`  ${name} ok`);
      } catch (err) {
        errors++;
        log(`  ${name} failed (as it may have originally): ${(err as Error).message.split('\n')[0]!.slice(0, 120)}`);
      }
    }
  }
  return { submitted, calls, errors };
}
