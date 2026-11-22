// A simulated operator for full simulations: answers the planner's open questions from a fact
// sheet. In real use the person answers; this only stands in for them in SITL runs.

import { answerQuestion, type MissionPlan } from './plan.ts';
import { toolLoop, type ChatFn } from './llm.ts';

export async function simulatedOperator(plan: MissionPlan, facts: string, chat: ChatFn, log?: (s: string) => void): Promise<number> {
  const open = plan.questions.filter((q) => !q.answer);
  if (!open.length) return 0;
  const answered = new Set<string>();
  const list = open.map((q) => `### ${q.id} (section ${q.slot})\n${q.question}\n*why / suggested:* ${q.why}${q.options ? `\n*options:* ${q.options.join(' / ')}` : ''}`).join('\n\n');
  await toolLoop(chat, facts, `The planner of mission "${plan.id}" asks you these questions. Answer every one with \`answer\`, then call \`done\`.\n\n${list}`, [
    {
      name: 'answer', description: 'Answer one question.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
      run: (a) => {
        const id = String(a['id']);
        if (!open.some((q) => q.id === id)) throw new Error(`no open question ${id}`);
        answerQuestion(plan, id, String(a['text']));
        answered.add(id);
        return 'ok';
      },
    },
    { name: 'done', description: 'All answered.', terminal: true, parameters: { type: 'object', properties: {} }, run: () => (answered.size < open.length ? `still open: ${open.filter((q) => !answered.has(q.id)).map((q) => q.id).join(', ')}` : 'ok') },
  ], { log, maxSteps: 40 });
  return answered.size;
}
