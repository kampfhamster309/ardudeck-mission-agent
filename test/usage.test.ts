// Run: node --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatTotals, formatUsage, toolLoop, UsageMeter, type ChatFn } from '../src/planning/llm.ts';

test('formats a request and step totals against the 1M context', () => {
  assert.equal(
    formatUsage({ prompt: 42_300, completion: 3_100, thinking: 2_800, thinkingEstimated: true, ms: 41_000 }),
    '[tokens] context 42k (4.2% of 1000k) · out 3,100 (thinking ~2,800) · 41 s',
  );
  const m = new UsageMeter();
  m.start('x');
  m.record({ prompt: 10_000, completion: 500, thinking: 400, thinkingEstimated: true, ms: 1000 });
  m.record({ prompt: 30_000, completion: 700, thinking: 600, thinkingEstimated: true, ms: 2000 });
  assert.equal(formatTotals(m.totals), '[tokens] 2 requests · context up to 30k (3.0%) · read 40k · wrote 1,200 (thinking 1,000) · model time 3 s');
});

test('the tool loop sums usage, and the meter writes one JSONL line per request', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'usage-')), 'usage.jsonl');
  const meter = new UsageMeter(file);
  meter.start('planner round 1');
  let n = 0;
  const chat: ChatFn = async () => {
    n++;
    const u = { prompt: 1000 * n, completion: 100, thinking: 50, thinkingEstimated: true, ms: 10 };
    meter.record(u);
    return n < 2
      ? { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'noop', arguments: '{}' } }], usage: u }
      : { content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'done', arguments: '{}' } }], usage: u };
  };
  const r = await toolLoop(chat, 's', 'u', [
    { name: 'noop', description: '', parameters: { type: 'object', properties: {} }, run: () => 'ok' },
    { name: 'done', description: '', parameters: { type: 'object', properties: {} }, run: () => 'ok', terminal: true },
  ]);
  assert.deepEqual({ requests: r.usage.requests, prompt: r.usage.prompt, maxPrompt: r.usage.maxPrompt }, { requests: 2, prompt: 3000, maxPrompt: 2000 });
  const lines = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].step, 'planner round 1');
});

test('images from a tool result follow as a user message with data URLs', async () => {
  let n = 0;
  let seen: any[] = [];
  const chat: ChatFn = async (messages) => {
    n++;
    seen = [...messages];
    return n < 2
      ? { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] }
      : { content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'done', arguments: '{}' } }] };
  };
  await toolLoop(chat, 's', 'u', [
    { name: 'screenshot', description: '', parameters: { type: 'object', properties: {} }, run: () => ({ text: 'shot', images: [{ mime: 'image/png', data: 'AAAA' }] }) },
    { name: 'done', description: '', parameters: { type: 'object', properties: {} }, run: () => 'ok', terminal: true },
  ]);
  const tool = seen.find((m) => m.role === 'tool');
  assert.match(tool.content, /1 image\(s\) follow/);
  const img = seen.at(-1);
  assert.equal(img.role, 'user');
  assert.equal(img.content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('a chat that runs out of tokens while thinking asks again one effort lower, down to medium', async () => {
  const { openAiChat, lowerEffort } = await import('../src/planning/llm.ts');
  assert.equal(lowerEffort(undefined), 'high');
  assert.equal(lowerEffort('high'), 'medium');
  assert.equal(lowerEffort('medium'), undefined);
  const http = await import('node:http');
  const efforts: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      efforts.push(body.reasoning_effort);
      const out = body.reasoning_effort === 'medium'
        ? { finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'ok', tool_calls: [{ id: 't', type: 'function', function: { name: 'done', arguments: '{}' } }] } }
        : { finish_reason: 'length', message: { content: null, reasoning_content: 'x'.repeat(1000) } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [out], usage: { prompt_tokens: 10, completion_tokens: 100 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const lines: string[] = [];
    const chat = openAiChat({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', reasoningEffort: 'high' }, (l) => lines.push(l));
    const r = await chat([{ role: 'user', content: 'x' }], []);
    assert.deepEqual(efforts, ['high', 'medium']);
    assert.equal(r.tool_calls?.[0]?.function.name, 'done');
    assert.ok(lines.some((l) => /asking again at effort medium/.test(l)));
    assert.equal(r.usage?.thinking, 98); // 100 minus the ~2 tokens of the tool call
  } finally {
    server.close();
  }
});
