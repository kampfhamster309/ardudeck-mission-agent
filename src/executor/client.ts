// The executor's only way to the rover: the module's control port (127.0.0.1:8765), so the
// module's gate (armed + Guided + same vehicle) stays the single path to the vehicle.

export interface AgentStatus {
  canDrive: boolean;
  refusal: string | null;
  telemetry: { lat?: number; lon?: number; groundspeed?: number; heading?: number; at?: number };
  behaviour: string | null;
}

export interface CallResult { ok?: boolean; error?: string | null; sent?: number }

export interface AgentClient {
  status(): Promise<AgentStatus>;
  goto(lat: number, lon: number, speed?: number): Promise<CallResult>;
  velocity(forward: number, yawRate: number, seconds: number): Promise<CallResult>;
  stop(): Promise<CallResult>;
}

export class HttpAgentClient implements AgentClient {
  private base: string;
  constructor(base = 'http://127.0.0.1:8765') {
    this.base = base.replace(/\/$/, '');
  }

  private async call<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    const res = await fetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.ceil(timeoutMs)), // must be an integer (a fractional turn chunk gives e.g. 10415.9)
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  status() { return this.call<AgentStatus>('/status'); }
  goto(lat: number, lon: number, speed?: number) { return this.call<CallResult>('/goto', { lat, lon, ...(speed ? { speed } : {}) }); }
  velocity(forward: number, yawRate: number, seconds: number) {
    return this.call<CallResult>('/velocity', { forward, yawRate, seconds }, seconds * 1000 + 10_000);
  }
  stop() { return this.call<CallResult>('/stop', {}); }
}
