// Mission plan format and the operations that change it.
//
// Adapted from Lore's feature planning: a shared document with fixed sections, drafted by the
// planner, edited by the operator at the same time. Rules carried over:
//  * the planner never overwrites what the operator wrote, it extends it;
//  * questions belong to people: the planner adds them, never edits or removes them;
//    answered questions are settled decisions;
//  * findings come from the validator; while an error finding stands the plan can't be approved.

export const SLOTS = ['goal', 'success', 'area', 'configuration', 'phases', 'safety'] as const;
export type Slot = (typeof SLOTS)[number];
export type Author = 'planner' | 'operator';

export const SECTION_TITLES: Record<Slot, string> = {
  goal: 'Goal',
  success: 'Success criteria',
  area: 'Area and limits',
  configuration: 'Rover configuration',
  phases: 'Phases',
  safety: 'Abort and safety',
};

/** What each section's structured `items` look like. Prose carries the reasoning, items the data. */
export interface SuccessItem { id: string; criterion: string; measured_by: string; target?: string }
export interface AreaItems {
  site?: string | null;
  geofence?: Array<[number, number]> | null; // [lat, lon] polygon
  no_go?: Array<{ name: string; polygon?: Array<[number, number]>; note?: string }>;
  limits?: { max_speed_mps?: number | null; max_duration_min?: number | null; [k: string]: unknown };
  targets?: Array<{ name: string; lat?: number | null; lon?: number | null; note?: string }>;
}
export interface ConfigItem { need: string; provided_by: string | null; status: 'available' | 'missing' | 'unknown'; note?: string }
export interface PhaseItem {
  id: string;
  name: string;
  behaviour: string;
  params?: Record<string, unknown>;
  exit_condition: string;
  on_failure: string;
}
export interface SafetyItem { condition: string; action: string }

export type SectionItems = SuccessItem[] | AreaItems | ConfigItem[] | PhaseItem[] | SafetyItem[];

export interface Section {
  prose: string;
  prose_author: Author | null;
  items: SectionItems | null;
  items_author: Author | null;
}

export interface Question {
  id: string;
  slot: Slot | 'general';
  question: string;
  why: string;
  options?: string[];
  answer?: { text: string; at: string };
}

export type FindingKind = 'inconsistency' | 'incompleteness' | 'infeasibility';
export interface Finding {
  id: string;
  slot: Slot | 'general';
  kind: FindingKind;
  severity: 'error' | 'warning';
  text: string;
  evidence?: string;
  source: 'check' | 'validator';
}

export interface HistoryEntry { at: string; by: Author | 'validator'; action: string }

export interface MissionPlan {
  schema_version: 1;
  id: string;
  title: string;
  request: string;
  status: 'draft' | 'approved';
  round: number;
  created: string;
  updated: string;
  sections: Record<Slot, Section>;
  questions: Question[];
  findings: Finding[];
  /** A refine request for one section, cleared when the planner finishes the round. */
  refine?: { slot: Slot; brief: string } | null;
  history: HistoryEntry[];
}

const now = () => new Date().toISOString();

export function newPlan(id: string, request: string, title = request.slice(0, 60)): MissionPlan {
  const sections = Object.fromEntries(
    SLOTS.map((s) => [s, { prose: '', prose_author: null, items: null, items_author: null }]),
  ) as Record<Slot, Section>;
  const t = now();
  return {
    schema_version: 1, id, title, request, status: 'draft', round: 0, created: t, updated: t,
    sections, questions: [], findings: [], refine: null, history: [{ at: t, by: 'operator', action: 'created' }],
  };
}

export class PlanEditError extends Error {}

function isSlot(s: string): s is Slot {
  return (SLOTS as readonly string[]).includes(s);
}

function touch(plan: MissionPlan, by: HistoryEntry['by'], action: string) {
  plan.updated = now();
  plan.history.push({ at: plan.updated, by, action });
}

function requireDraft(plan: MissionPlan) {
  if (plan.status !== 'draft') throw new PlanEditError('plan is approved; reopen it before editing');
}

// --- planner operations (each refuses what Lore's planner may not do) ---------------------

/** Replace a section's prose. Refused when the operator wrote the current prose: extend it instead. */
export function setProse(plan: MissionPlan, slot: string, text: string, by: Author): void {
  requireDraft(plan);
  if (!isSlot(slot)) throw new PlanEditError(`unknown section "${slot}"; sections: ${SLOTS.join(', ')}`);
  const sec = plan.sections[slot];
  if (by === 'planner' && sec.prose_author === 'operator' && sec.prose.trim()) {
    throw new PlanEditError(`the operator wrote the ${slot} prose; use append_prose to extend it, don't replace it`);
  }
  sec.prose = text.trim();
  sec.prose_author = by;
  touch(plan, by, `set ${slot} prose`);
}

/** Add paragraphs to the end of a section's prose. Authorship stays with whoever wrote it first. */
export function appendProse(plan: MissionPlan, slot: string, text: string, by: Author): void {
  requireDraft(plan);
  if (!isSlot(slot)) throw new PlanEditError(`unknown section "${slot}"`);
  const sec = plan.sections[slot];
  sec.prose = sec.prose ? `${sec.prose}\n\n${text.trim()}` : text.trim();
  sec.prose_author ??= by;
  touch(plan, by, `appended to ${slot} prose`);
}

/** Replace a section's structured items. Refused for the planner when the operator set them. */
export function setItems(plan: MissionPlan, slot: string, items: unknown, by: Author): void {
  requireDraft(plan);
  if (!isSlot(slot)) throw new PlanEditError(`unknown section "${slot}"`);
  const problem = itemsProblem(slot, items);
  if (problem) throw new PlanEditError(`${slot} items: ${problem}`);
  const sec = plan.sections[slot];
  if (by === 'planner' && sec.items_author === 'operator') {
    throw new PlanEditError(`the operator set the ${slot} items; ask with add_question if you think they must change`);
  }
  sec.items = items as SectionItems;
  sec.items_author = by;
  touch(plan, by, `set ${slot} items`);
}

/** Shape check for items, so the planner gets a precise error to correct. */
export function itemsProblem(slot: Slot, items: unknown): string | null {
  const arr = (need: string[]) => {
    if (!Array.isArray(items)) return 'must be a list';
    for (const [i, it] of items.entries()) {
      if (typeof it !== 'object' || it === null) return `item ${i} must be an object`;
      for (const k of need) if (!(k in it)) return `item ${i} is missing "${k}"`;
    }
    return null;
  };
  switch (slot) {
    case 'goal': return 'goal has prose only, no items';
    case 'success': return arr(['id', 'criterion', 'measured_by']);
    case 'configuration': {
      const p = arr(['need', 'provided_by', 'status']);
      if (p) return p;
      const bad = (items as ConfigItem[]).find((c) => !['available', 'missing', 'unknown'].includes(c.status));
      return bad ? `status must be available, missing or unknown (got "${bad.status}")` : null;
    }
    case 'phases': return arr(['id', 'name', 'behaviour', 'exit_condition', 'on_failure']);
    case 'safety': return arr(['condition', 'action']);
    case 'area': return typeof items === 'object' && items !== null && !Array.isArray(items) ? null : 'must be an object';
  }
}

export function addQuestion(
  plan: MissionPlan,
  q: { slot: string; question: string; why: string; options?: string[] },
): Question {
  requireDraft(plan);
  const slot = q.slot === 'general' || isSlot(q.slot) ? q.slot : null;
  if (!slot) throw new PlanEditError(`unknown section "${q.slot}" (use a section or "general")`);
  if (!q.question?.trim() || !q.why?.trim()) throw new PlanEditError('question and why are both required');
  const dup = plan.questions.find((x) => x.question.trim().toLowerCase() === q.question.trim().toLowerCase());
  if (dup) throw new PlanEditError(`already asked as ${dup.id}`);
  const question: Question = { id: `q${plan.questions.length + 1}`, slot, question: q.question.trim(), why: q.why.trim() };
  if (q.options?.length) question.options = q.options;
  plan.questions.push(question);
  touch(plan, 'planner', `asked ${question.id}`);
  return question;
}

// --- operator operations ----------------------------------------------------------------

export function answerQuestion(plan: MissionPlan, id: string, text: string): void {
  requireDraft(plan);
  const q = plan.questions.find((x) => x.id === id);
  if (!q) throw new PlanEditError(`no question ${id}`);
  q.answer = { text: text.trim(), at: now() };
  touch(plan, 'operator', `answered ${id}`);
}

export function requestRefine(plan: MissionPlan, slot: string, brief: string): void {
  requireDraft(plan);
  if (!isSlot(slot)) throw new PlanEditError(`unknown section "${slot}"`);
  plan.refine = { slot, brief: brief.trim() };
  touch(plan, 'operator', `asked to refine ${slot}`);
}

/** Why the plan can't be approved yet, empty when it can. */
export function approvalBlockers(plan: MissionPlan): string[] {
  const out: string[] = [];
  for (const s of SLOTS) if (!plan.sections[s].prose.trim()) out.push(`section "${SECTION_TITLES[s]}" is empty`);
  for (const q of plan.questions) if (!q.answer) out.push(`question ${q.id} is unanswered`);
  for (const f of plan.findings) if (f.severity === 'error') out.push(`finding ${f.id} (${f.kind}): ${f.text}`);
  return out;
}

export function approve(plan: MissionPlan): void {
  const blockers = approvalBlockers(plan);
  if (blockers.length) throw new PlanEditError(`can't approve:\n- ${blockers.join('\n- ')}`);
  plan.status = 'approved';
  touch(plan, 'operator', 'approved');
}

export function reopen(plan: MissionPlan): void {
  plan.status = 'draft';
  touch(plan, 'operator', 'reopened');
}

// --- rendering ----------------------------------------------------------------------------

function renderItems(items: SectionItems | null): string {
  if (!items) return '';
  return '\n\n```yaml\n' + toYamlish(items) + '\n```';
}

/** Compact, readable dump for the Markdown view (JSON is the stored format). */
function toYamlish(v: unknown, indent = ''): string {
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object' || x === null)) return JSON.stringify(v);
    return v.map((x) => `${indent}- ${toYamlish(x, indent + '  ').trimStart()}`).join('\n');
  }
  if (typeof v === 'object' && v !== null) {
    return Object.entries(v)
      .map(([k, x]) => (typeof x === 'object' && x !== null && !(Array.isArray(x) && x.every((y) => typeof y !== 'object')))
        ? `${indent}${k}:\n${toYamlish(x, indent + '  ')}`
        : `${indent}${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`)
      .join('\n');
  }
  return String(v);
}

export function renderMarkdown(plan: MissionPlan): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`, '', `*Mission plan ${plan.id} · ${plan.status} · round ${plan.round} · updated ${plan.updated}*`, '');
  lines.push(`> ${plan.request.replace(/\n/g, '\n> ')}`, '');
  const block = (slot: Slot | 'general') => {
    for (const q of plan.questions.filter((x) => x.slot === slot)) {
      lines.push(`**${q.id}${q.answer ? ' (answered)' : ' (open)'}:** ${q.question}`);
      lines.push(`  *why:* ${q.why}`);
      if (q.options) lines.push(`  *options:* ${q.options.join(' / ')}`);
      if (q.answer) lines.push(`  *answer:* ${q.answer.text}`);
      lines.push('');
    }
    for (const f of plan.findings.filter((x) => x.slot === slot)) {
      lines.push(`> **${f.severity.toUpperCase()} ${f.id} (${f.kind}):** ${f.text}${f.evidence ? ` *(${f.evidence})*` : ''}`, '');
    }
  };
  for (const s of SLOTS) {
    const sec = plan.sections[s];
    lines.push(`## ${SECTION_TITLES[s]}`, '');
    lines.push((sec.prose || '*(empty)*') + renderItems(sec.items), '');
    block(s);
  }
  if (plan.questions.some((q) => q.slot === 'general') || plan.findings.some((f) => f.slot === 'general')) {
    lines.push('## Open questions', '');
    block('general');
  }
  const blockers = approvalBlockers(plan);
  lines.push('---', '', blockers.length ? `**Not approvable yet:**\n- ${blockers.join('\n- ')}` : '**Ready for approval.**', '');
  return lines.join('\n');
}
