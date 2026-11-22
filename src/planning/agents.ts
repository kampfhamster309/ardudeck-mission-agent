// The planner and validator agents: their tools, and one round of each.

import { loadPrompt } from './prompts.ts';
import {
  SLOTS, addQuestion, appendProse, setItems, setProse,
  type Finding, type FindingKind, type MissionPlan,
} from './plan.ts';
import { runChecks } from './checks.ts';
import { toolLoop, type ChatFn, type LoopResult, type ToolDef } from './llm.ts';

export interface Context {
  /** Parsed rover/capabilities.yaml */
  capabilities: Record<string, unknown>;
  /** Parsed sites file, or {} when there is none */
  sites: Record<string, unknown>;
  capabilitiesText: string;
  sitesText: string;
}

const prompt = (name: string) => loadPrompt(name);

/** The plan as the agents see it: everything but the history. */
function planView(plan: MissionPlan): string {
  const { history: _h, ...rest } = plan;
  return JSON.stringify(rest, null, 1);
}

function readTools(plan: MissionPlan, ctx: Context): ToolDef[] {
  const obj = { type: 'object', properties: {} };
  return [
    { name: 'read_plan', description: 'Read the current mission plan (sections, questions with answers, findings, refine request).', parameters: obj, run: () => planView(plan) },
    { name: 'read_capabilities', description: 'Read the rover capability model (YAML). The only source of truth about the rover.', parameters: obj, run: () => ctx.capabilitiesText },
    {
      name: 'read_sites', description: 'Read the named places the operator has defined (areas, corners, home), with coordinates.', parameters: obj,
      run: () => ctx.sitesText.trim() || 'No sites defined yet. Ask the operator for any place the mission needs.',
    },
  ];
}

const slotEnum = { type: 'string', enum: [...SLOTS] };

export async function runPlannerRound(plan: MissionPlan, ctx: Context, chat: ChatFn, log?: (s: string) => void): Promise<LoopResult & { summary: string }> {
  let summary = '';
  const tools: ToolDef[] = [
    ...readTools(plan, ctx),
    {
      name: 'set_prose', description: "Replace a section's prose (Markdown). Refused if the operator wrote it: use append_prose then.",
      parameters: { type: 'object', properties: { slot: slotEnum, text: { type: 'string' } }, required: ['slot', 'text'] },
      run: (a) => { setProse(plan, String(a['slot']), String(a['text']), 'planner'); return 'ok'; },
    },
    {
      name: 'append_prose', description: "Add paragraphs to the end of a section's prose.",
      parameters: { type: 'object', properties: { slot: slotEnum, text: { type: 'string' } }, required: ['slot', 'text'] },
      run: (a) => { appendProse(plan, String(a['slot']), String(a['text']), 'planner'); return 'ok'; },
    },
    {
      name: 'set_items', description: "Replace a section's structured items (shape per section as described in your instructions).",
      parameters: { type: 'object', properties: { slot: slotEnum, items: { description: 'list or object, per section' } }, required: ['slot', 'items'] },
      run: (a) => {
        let items = a['items'];
        if (typeof items === 'string') items = JSON.parse(items); // some models send JSON as a string
        setItems(plan, String(a['slot']), items, 'planner');
        return 'ok';
      },
    },
    {
      name: 'add_question', description: 'Ask the operator something only a person can decide or measure.',
      parameters: {
        type: 'object',
        properties: {
          slot: { type: 'string', enum: [...SLOTS, 'general'] },
          question: { type: 'string' },
          why: { type: 'string', description: 'why it matters, and the answer you would pick' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['slot', 'question', 'why'],
      },
      run: (a) => {
        const q = addQuestion(plan, { slot: String(a['slot']), question: String(a['question']), why: String(a['why']), options: a['options'] as string[] | undefined });
        return `asked as ${q.id}`;
      },
    },
    {
      name: 'done', description: 'Finish this round.', terminal: true,
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      run: (a) => { summary = String(a['summary'] ?? ''); return 'ok'; },
    },
  ];

  const round = plan.refine
    ? `Refine round. The operator asked you to rework the section "${plan.refine.slot}": ${plan.refine.brief}\nChange only that section, plus whatever a settled answer or a finding makes wrong elsewhere.`
    : plan.round === 0
      ? `First draft. The operator's mission request:\n\n${plan.request}\n\nDraft every section.`
      : 'Update round. Write every newly answered question into its section, fix every finding, and keep everything else as it is. Ask new questions only where an answer opened a new gap.';
  const system = prompt('planner').replace('{round}', round);
  const result = await toolLoop(chat, system, `Mission plan ${plan.id}. Start with read_capabilities, read_sites and read_plan.`, tools, { log, maxSteps: 50 });
  plan.round += 1;
  plan.refine = null;
  plan.history.push({ at: new Date().toISOString(), by: 'planner', action: `round ${plan.round}${summary ? `: ${summary}` : ''}` });
  return { ...result, summary };
}

export async function runValidation(
  plan: MissionPlan, ctx: Context, chat: ChatFn | null, log?: (s: string) => void, onTranscript?: (t: unknown) => void,
): Promise<Finding[]> {
  const findings: Finding[] = runChecks(plan, ctx.capabilities);
  if (chat) {
    const tools: ToolDef[] = [
      ...readTools(plan, ctx),
      {
        name: 'report_finding', description: 'Report one problem in the plan.',
        parameters: {
          type: 'object',
          properties: {
            slot: { type: 'string', enum: [...SLOTS, 'general'] },
            kind: { type: 'string', enum: ['inconsistency', 'incompleteness', 'infeasibility'] },
            severity: { type: 'string', enum: ['error', 'warning'] },
            text: { type: 'string' },
            evidence: { type: 'string' },
          },
          required: ['slot', 'kind', 'severity', 'text'],
        },
        run: (a) => {
          const n = findings.filter((f) => f.source === 'validator').length + 1;
          findings.push({
            id: `v${n}`, slot: String(a['slot']) as Finding['slot'], kind: String(a['kind']) as FindingKind,
            severity: a['severity'] === 'error' ? 'error' : 'warning', text: String(a['text']),
            ...(a['evidence'] ? { evidence: String(a['evidence']) } : {}), source: 'validator',
          });
          return `recorded v${n}`;
        },
      },
      { name: 'done', description: 'Finish validating.', terminal: true, parameters: { type: 'object', properties: {} }, run: () => 'ok' },
    ];
    try {
      const r = await toolLoop(chat, prompt('validator'), `Validate mission plan ${plan.id}. Read it, then report each problem with report_finding and call done.`, tools, { log, maxSteps: 30 });
      onTranscript?.(r.transcript);
    } catch (err) {
      onTranscript?.((err as { transcript?: unknown }).transcript ?? []);
      throw err;
    }
  }
  // A fresh pass replaces the old findings: a finding clears once its cause is gone.
  plan.findings = findings;
  plan.history.push({ at: new Date().toISOString(), by: 'validator', action: `${findings.length} findings` });
  return findings;
}
