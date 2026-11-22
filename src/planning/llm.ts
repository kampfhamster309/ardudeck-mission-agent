// Minimal OpenAI-compatible chat client with a tool-calling loop (llama.cpp, vLLM, Ollama,
// the strixbox's halogen server, ...). No SDK dependency.

import { appendFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { dirname } from 'node:path';
import https from 'node:https';

/** Answer limit per request. Reasoning models think before the tool call; the strixbox model has 1M context. */
export const DEFAULT_MAX_TOKENS = 65_536;

export interface LlmConfig {
  baseUrl: string; // e.g. http://host:port/v1
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** reasoning_effort for servers that take it (minimal|low|medium|high|xhigh); unset = server default */
  reasoningEffort?: string;
}

/** Effort levels, lowest first. When an answer runs out of tokens while thinking, the retry steps down one. */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
/** The lowest effort the automatic step-down goes to. */
const MIN_STEP_DOWN = 'medium';

export function lowerEffort(effort: string | undefined): string | undefined {
  const i = EFFORTS.indexOf(effort ?? 'xhigh');
  if (i <= EFFORTS.indexOf(MIN_STEP_DOWN)) return undefined;
  return EFFORTS[i - 1];
}

export function llmConfigFromEnv(env = process.env): LlmConfig {
  const baseUrl = env['MISSION_LLM_URL'];
  const model = env['MISSION_LLM_MODEL'];
  if (!baseUrl || !model) {
    throw new Error('set MISSION_LLM_URL (OpenAI-compatible base URL, ending in /v1) and MISSION_LLM_MODEL');
  }
  const maxTokens = env['MISSION_LLM_MAX_TOKENS'] ? Number(env['MISSION_LLM_MAX_TOKENS']) : undefined;
  const reasoningEffort = env['MISSION_LLM_REASONING_EFFORT'] || undefined;
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, apiKey: env['MISSION_LLM_KEY'], maxTokens, reasoningEffort };
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Returns text for the model. Throwing returns the error message to the model instead. */
  run(args: Record<string, unknown>): Promise<ToolOutput> | ToolOutput;
  /** Ends the loop after it runs. */
  terminal?: boolean;
}

/** A tool's result: text, or text plus images (sent to the model in a message after the result). */
export type ToolOutput = string | { text: string; images: Array<{ mime: string; data: string }> };

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

type Msg =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

/** Token use of one request. thinking is estimated from the reasoning text (~4 chars/token) when the server doesn't report it. */
export interface Usage { prompt: number; completion: number; thinking: number; thinkingEstimated: boolean; ms: number }

/** Totals over a loop: requests, summed tokens, and the largest prompt (= the context the model had to hold). */
export interface UsageTotals { requests: number; prompt: number; completion: number; thinking: number; maxPrompt: number; ms: number }

export function emptyTotals(): UsageTotals {
  return { requests: 0, prompt: 0, completion: 0, thinking: 0, maxPrompt: 0, ms: 0 };
}

export function addUsage(t: UsageTotals, u: Usage): void {
  t.requests++;
  t.prompt += u.prompt;
  t.completion += u.completion;
  t.thinking += u.thinking;
  t.maxPrompt = Math.max(t.maxPrompt, u.prompt);
  t.ms += u.ms;
}

/** Context window to report against (MISSION_LLM_CONTEXT, default 1M: the strixbox's qwen3.8-flash-next). */
export const CONTEXT_TOKENS = Number(process.env['MISSION_LLM_CONTEXT'] ?? 1_000_000);

const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n.toLocaleString('en'));
const pct = (n: number) => `${((n / CONTEXT_TOKENS) * 100).toFixed(n / CONTEXT_TOKENS < 0.1 ? 1 : 0)}%`;

export function formatUsage(u: Usage): string {
  return `[tokens] context ${k(u.prompt)} (${pct(u.prompt)} of ${k(CONTEXT_TOKENS)}) · out ${k(u.completion)} (thinking ${u.thinkingEstimated ? '~' : ''}${k(u.thinking)}) · ${(u.ms / 1000).toFixed(0)} s`;
}

export function formatTotals(t: UsageTotals): string {
  return `[tokens] ${t.requests} requests · context up to ${k(t.maxPrompt)} (${pct(t.maxPrompt)}) · read ${k(t.prompt)} · wrote ${k(t.completion)} (thinking ${k(t.thinking)}) · model time ${(t.ms / 1000).toFixed(0)} s`;
}

export interface LoopResult { steps: number; finished: boolean; toolCalls: number; transcript: Msg[]; usage: UsageTotals }

/**
 * POST JSON with node:http(s) rather than fetch: fetch (undici) gives up when no response
 * headers arrive within 5 minutes, and a reasoning model can think longer than that.
 */
/**
 * Per-request timeout: long enough for the whole answer limit at a slow 20 tokens/s, plus 5 min
 * (MISSION_LLM_TIMEOUT_S overrides). A thinking model can use most of the limit before answering.
 */
export function defaultTimeoutMs(maxTokens: number): number {
  const env = Number(process.env['MISSION_LLM_TIMEOUT_S']);
  if (env > 0) return env * 1000;
  return Math.round((maxTokens / 20 + 300) * 1000);
}

function postJson(url: string, body: unknown, apiKey: string | undefined, timeoutMs: number, waiting?: (seconds: number) => void): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const data = Buffer.from(JSON.stringify(body));
  const mod = u.protocol === 'https:' ? https : http;
  const t0 = Date.now();
  const tick = waiting ? setInterval(() => waiting(Math.round((Date.now() - t0) / 1000)), 120_000) : null;
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 60000)} min`)));
    req.on('error', reject);
    req.end(data);
  }).finally(() => { if (tick) clearInterval(tick); });
}

export type ChatFn = (messages: Msg[], tools: ToolDef[]) => Promise<{ content: string | null; tool_calls?: ToolCall[]; usage?: Usage }>;

/**
 * @param onUsage called after every request (e.g. to append to a usage log file)
 */
export function openAiChat(cfg: LlmConfig, log: (s: string) => void = () => {}, onUsage?: (u: Usage) => void): ChatFn {
  const once = async (messages: Msg[], tools: ToolDef[], effort: string | undefined) => {
    const t0 = Date.now();
    const res = await postJson(`${cfg.baseUrl}/chat/completions`, {
      model: cfg.model,
      messages,
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      temperature: cfg.temperature ?? 0.3,
      max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(effort ? { reasoning_effort: effort } : {}),
    }, cfg.apiKey, cfg.timeoutMs ?? defaultTimeoutMs(cfg.maxTokens ?? DEFAULT_MAX_TOKENS), (s) => log(`  (still waiting for the model: ${s} s)`));
    if (res.status < 200 || res.status >= 300) throw new Error(`LLM HTTP ${res.status}: ${res.body.slice(0, 300)}`);
    const data = JSON.parse(res.body) as {
      choices: Array<{ finish_reason?: string; message: { content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const choice = data.choices[0];
    if (!choice) throw new Error('LLM returned no choices');
    if (choice.finish_reason === 'length') {
      log(`  (model hit the ${cfg.maxTokens ?? DEFAULT_MAX_TOKENS}-token answer limit; prompt ${data.usage?.prompt_tokens ?? '?'} tokens)`);
    }
    const reported = data.usage?.completion_tokens_details?.reasoning_tokens;
    // Not reported: everything that isn't visible answer is thinking (answer text ~4 chars/token;
    // reasoning text is denser per token, so counting its characters underestimates it).
    const visible = (choice.message.content?.length ?? 0) + (choice.message.tool_calls ?? []).reduce((n, c) => n + c.function.arguments.length + c.function.name.length, 0);
    const completion = data.usage?.completion_tokens ?? 0;
    const usage: Usage = {
      prompt: data.usage?.prompt_tokens ?? 0,
      completion,
      thinking: reported ?? (choice.message.reasoning_content ? Math.max(0, completion - Math.round(visible / 4)) : 0),
      thinkingEstimated: reported === undefined,
      ms: Date.now() - t0,
    };
    log(`  ${formatUsage(usage)}${effort ? ` · effort ${effort}` : ''}`);
    onUsage?.(usage);
    const ranOut = choice.finish_reason === 'length' && !choice.message.tool_calls?.length;
    return { content: choice.message.content, tool_calls: choice.message.tool_calls, usage, ranOut };
  };
  const attempt = async (messages: Msg[], tools: ToolDef[], effort: string | undefined) => {
    try {
      return await once(messages, tools, effort);
    } catch (err) {
      log(`  (LLM request failed: ${(err as Error).message}; retrying once)`);
      return once(messages, tools, effort);
    }
  };
  return async (messages, tools) => {
    let effort = cfg.reasoningEffort;
    for (;;) {
      const r = await attempt(messages, tools, effort);
      const next = r.ranOut ? lowerEffort(effort) : undefined;
      if (!next) return { content: r.content, tool_calls: r.tool_calls, usage: r.usage };
      // Thought through the whole answer limit without answering: ask again, thinking less.
      log(`  (no answer within the token limit at effort ${effort ?? 'default (xhigh)'}; asking again at effort ${next})`);
      effort = next;
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
  const usage = emptyTotals();
  const pendingImages: Array<{ tool: string; images: Array<{ mime: string; data: string }> }> = [];
  for (let step = 1; step <= (opts.maxSteps ?? 40); step++) {
    let reply: Awaited<ReturnType<ChatFn>>;
    try {
      reply = await chat(messages, tools);
    } catch (err) {
      throw Object.assign(err as Error, { transcript: messages, usage });
    }
    if (reply.usage) addUsage(usage, reply.usage);
    messages.push({ role: 'assistant', content: reply.content ?? null, ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls } : {}) });
    if (!reply.tool_calls?.length) {
      log(`  (no tool call) ${(reply.content ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
      if (++idle >= 2) return { steps: step, finished: false, toolCalls, transcript: messages, usage };
      messages.push({ role: 'user', content: 'Use the tools to make your changes. Call `done` when you have finished.' });
      continue;
    }
    idle = 0;
    let finished = false;
    for (const call of reply.tool_calls) {
      toolCalls++;
      const tool = byName.get(call.function.name);
      let out: string;
      let images: Array<{ mime: string; data: string }> = [];
      if (!tool) {
        out = `error: no tool "${call.function.name}"`;
      } else {
        try {
          const args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
          const r = await tool.run(args);
          if (typeof r === 'string') out = r;
          else { out = r.text; images = r.images; }
          if (tool.terminal) finished = true;
        } catch (err) {
          out = `error: ${(err as Error).message}`;
        }
      }
      log(`  ${call.function.name} ${summarizeArgs(call.function.arguments)} -> ${out.split('\n')[0]!.slice(0, 120)}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: images.length ? `${out}\n(${images.length} image(s) follow in the next message)` : out });
      // chat APIs take only text in tool results: images go in a user message right after
      if (images.length) pendingImages.push({ tool: call.function.name, images });
    }
    if (pendingImages.length) {
      const parts: ContentPart[] = [];
      for (const p of pendingImages.splice(0)) {
        parts.push({ type: 'text', text: `Image(s) from \`${p.tool}\`:` });
        for (const im of p.images) parts.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } });
      }
      messages.push({ role: 'user', content: parts });
    }
    if (finished) return { steps: step, finished: true, toolCalls, transcript: messages, usage };
  }
  return { steps: opts.maxSteps ?? 40, finished: false, toolCalls, transcript: messages, usage };
}

function summarizeArgs(raw: string): string {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(a).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.slice(0, 40)) : JSON.stringify(v)?.slice(0, 40)}`).join(' ');
  } catch {
    return raw.slice(0, 60);
  }
}

/** Collects token use per step and appends every request to a JSONL file. */
export class UsageMeter {
  totals = emptyTotals();
  label = '';
  private file: string | undefined;
  constructor(file?: string) {
    this.file = file;
  }
  /** Start a new step; returns the previous step's totals. */
  start(label: string): UsageTotals {
    const prev = this.totals;
    this.label = label;
    this.totals = emptyTotals();
    return prev;
  }
  record = (u: Usage): void => {
    addUsage(this.totals, u);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), step: this.label, ...u }) + '\n');
    }
  };
}
