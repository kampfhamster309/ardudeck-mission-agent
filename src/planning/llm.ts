// Minimal OpenAI-compatible chat client with a tool-calling loop (llama.cpp, vLLM, Ollama,
// the strixbox's halogen server, ...). No SDK dependency.

/** Answer limit per request. Reasoning models think before the tool call; the strixbox model has 1M context. */
export const DEFAULT_MAX_TOKENS = 65_536;

export interface LlmConfig {
  baseUrl: string; // e.g. http://host:port/v1
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export function llmConfigFromEnv(env = process.env): LlmConfig {
  const baseUrl = env['MISSION_LLM_URL'];
  const model = env['MISSION_LLM_MODEL'];
  if (!baseUrl || !model) {
    throw new Error('set MISSION_LLM_URL (OpenAI-compatible base URL, ending in /v1) and MISSION_LLM_MODEL');
  }
  const maxTokens = env['MISSION_LLM_MAX_TOKENS'] ? Number(env['MISSION_LLM_MAX_TOKENS']) : undefined;
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, apiKey: env['MISSION_LLM_KEY'], maxTokens };
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Returns text for the model. Throwing returns the error message to the model instead. */
  run(args: Record<string, unknown>): Promise<string> | string;
  /** Ends the loop after it runs. */
  terminal?: boolean;
}

type Msg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export interface LoopResult { steps: number; finished: boolean; toolCalls: number; transcript: Msg[] }

export type ChatFn = (messages: Msg[], tools: ToolDef[]) => Promise<{ content: string | null; tool_calls?: ToolCall[] }>;

export function openAiChat(cfg: LlmConfig, log: (s: string) => void = () => {}): ChatFn {
  const once = async (messages: Msg[], tools: ToolDef[]) => {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        temperature: cfg.temperature ?? 0.3,
        max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 1_200_000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices: Array<{ finish_reason?: string; message: { content: string | null; tool_calls?: ToolCall[] } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices[0];
    if (!choice) throw new Error('LLM returned no choices');
    if (choice.finish_reason === 'length') {
      log(`  (model hit the ${cfg.maxTokens ?? DEFAULT_MAX_TOKENS}-token answer limit; prompt ${data.usage?.prompt_tokens ?? '?'} tokens)`);
    }
    return { content: choice.message.content, tool_calls: choice.message.tool_calls };
  };
  return async (messages, tools) => {
    try {
      return await once(messages, tools);
    } catch (err) {
      log(`  (LLM request failed: ${(err as Error).message}; retrying once)`);
      return once(messages, tools);
    }
  };
}

/** Run the model until it calls a terminal tool, stops calling tools twice in a row, or hits maxSteps. */
export async function toolLoop(
  chat: ChatFn,
  system: string,
  user: string,
  tools: ToolDef[],
  opts: { maxSteps?: number; log?: (line: string) => void } = {},
): Promise<LoopResult> {
  const log = opts.log ?? (() => {});
  const messages: Msg[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const byName = new Map(tools.map((t) => [t.name, t]));
  let toolCalls = 0;
  let idle = 0;
  for (let step = 1; step <= (opts.maxSteps ?? 40); step++) {
    let reply: Awaited<ReturnType<ChatFn>>;
    try {
      reply = await chat(messages, tools);
    } catch (err) {
      throw Object.assign(err as Error, { transcript: messages });
    }
    messages.push({ role: 'assistant', content: reply.content ?? null, ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls } : {}) });
    if (!reply.tool_calls?.length) {
      log(`  (no tool call) ${(reply.content ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
      if (++idle >= 2) return { steps: step, finished: false, toolCalls, transcript: messages };
      messages.push({ role: 'user', content: 'Use the tools to make your changes. Call `done` when you have finished.' });
      continue;
    }
    idle = 0;
    let finished = false;
    for (const call of reply.tool_calls) {
      toolCalls++;
      const tool = byName.get(call.function.name);
      let out: string;
      if (!tool) {
        out = `error: no tool "${call.function.name}"`;
      } else {
        try {
          const args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
          out = await tool.run(args);
          if (tool.terminal) finished = true;
        } catch (err) {
          out = `error: ${(err as Error).message}`;
        }
      }
      log(`  ${call.function.name} ${summarizeArgs(call.function.arguments)} -> ${out.split('\n')[0]!.slice(0, 120)}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
    if (finished) return { steps: step, finished: true, toolCalls, transcript: messages };
  }
  return { steps: opts.maxSteps ?? 40, finished: false, toolCalls, transcript: messages };
}

function summarizeArgs(raw: string): string {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(a).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.slice(0, 40)) : JSON.stringify(v)?.slice(0, 40)}`).join(' ');
  } catch {
    return raw.slice(0, 60);
  }
}
