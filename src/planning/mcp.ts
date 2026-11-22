// Minimal MCP client over stdio (JSON-RPC 2.0, one message per line), no SDK. Used to hand an
// MCP server's tools (SolidCraft, for designing addons) to the LLM agents.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ToolDef, ToolOutput } from './llm.ts';

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

export class McpStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  instructions = '';
  private command: string;
  private args: string[];

  constructor(command: string, args: string[] = []) {
    this.command = command;
    this.args = args;
  }

  async start(): Promise<void> {
    const proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = proc;
    proc.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error(`${this.command} exited`));
      this.pending.clear();
    });
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === undefined) return; // notifications
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jetrover-mission-agent', version: '0.1.0' },
    }) as { instructions?: string };
    this.instructions = init.instructions ?? '';
    this.notify('notifications/initialized');
  }

  private send(msg: unknown) {
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private notify(method: string, params: unknown = {}) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown, timeoutMs = 600_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async listTools(): Promise<McpTool[]> {
    const r = await this.request('tools/list', {}) as { tools: McpTool[] };
    return r.tools;
  }

  /** Call a tool; returns its text content. Throws on errors. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.callToolRich(name, args);
    return typeof r === 'string' ? r : r.text;
  }

  /** Call a tool; returns text, plus images when the tool returns any (e.g. a screenshot). */
  async callToolRich(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    const r = await this.request('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean;
    };
    const content = r.content ?? [];
    const text = content.map((c) => (c.type === 'text' ? c.text ?? '' : c.type === 'image' ? '[image]' : `[${c.type} omitted]`)).join('\n');
    if (r.isError) throw new Error(text || `${name} failed`);
    const images = content.filter((c) => c.type === 'image' && c.data).map((c) => ({ mime: c.mimeType ?? 'image/png', data: c.data! }));
    return images.length ? { text, images } : text;
  }

  /** The server's tools as agent tools, except `exclude`. */
  async asToolDefs(exclude: string[] = []): Promise<ToolDef[]> {
    const tools = await this.listTools();
    return tools.filter((t) => !exclude.includes(t.name)).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
      run: (a: Record<string, unknown>) => this.callToolRich(t.name, a),
    }));
  }

  close() {
    this.proc?.kill();
    this.proc = null;
  }
}
