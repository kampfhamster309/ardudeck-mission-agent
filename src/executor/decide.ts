// The LLM at a decision point: the spec briefing plus what went wrong -> retry/skip/hold/abort.

import { readFileSync } from 'node:fs';
import { renderSpecMarkdown } from '../planning/spec.ts';
import { toolLoop, type ChatFn } from '../planning/llm.ts';
import type { DecideFn, Decision, DecisionAction } from './executor.ts';

const ACTIONS: DecisionAction[] = ['retry', 'skip', 'hold', 'abort'];

/** ArduRover custom_mode numbers, so the model reads names, not codes. */
const ROVER_MODES: Record<number, string> = { 0: 'MANUAL', 1: 'ACRO', 3: 'STEERING', 4: 'HOLD', 5: 'LOITER', 6: 'FOLLOW', 7: 'SIMPLE', 10: 'AUTO', 11: 'RTL', 12: 'SMART_RTL', 15: 'GUIDED' };

function describeTelemetry(t: Record<string, unknown> | undefined): string {
  if (!t) return 'none';
  const { customMode, mavType: _m, at: _a, ...rest } = t;
  const mode = typeof customMode === 'number' ? (ROVER_MODES[customMode] ?? `mode ${customMode}`) : undefined;
  return JSON.stringify({ ...(mode ? { mode } : {}), ...rest });
}

export function llmDecider(chat: ChatFn, log?: (s: string) => void): DecideFn {
  const system = readFileSync(new URL('../../prompts/decision.md', import.meta.url), 'utf-8');
  return async ({ spec, step, attempt, maxRetries, failure, status }) => {
    let decision: Decision | null = null;
    const user = [
      renderSpecMarkdown(spec),
      '---',
      `## Decision needed`,
      '',
      `Step **${step.id} ${step.name}** (\`${step.behaviour}\`) failed on attempt ${attempt} (${Math.max(0, maxRetries + 1 - attempt)} retries left).`,
      `On failure, the spec says: ${step.on_failure}`,
      `What happened: ${failure}`,
      `Rover drivable by the agent right now: ${status ? (status.canDrive ? 'yes (armed, GUIDED)' : `no (${status.refusal})`) : 'unknown (module unreachable)'}`,
      `Last telemetry: ${describeTelemetry(status?.telemetry)}`,
      '',
      'Call `decide`.',
    ].join('\n');
    await toolLoop(chat, system, user, [{
      name: 'decide',
      description: 'Choose what happens next.',
      terminal: true,
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ACTIONS }, reason: { type: 'string' } },
        required: ['action', 'reason'],
      },
      run: (a) => {
        const action = String(a['action']) as DecisionAction;
        if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
        decision = { action, reason: String(a['reason'] ?? ''), by: 'llm' };
        return 'ok';
      },
    }], { log, maxSteps: 4 });
    return decision ?? { action: 'hold', reason: 'the model gave no decision', by: 'policy' };
  };
}

/** Without an LLM: follow nothing clever, just hand the mission to the operator. */
export const holdDecider: DecideFn = async () => ({ action: 'hold', reason: 'no decision model configured', by: 'policy' });
