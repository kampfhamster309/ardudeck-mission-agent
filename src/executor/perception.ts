// What the rover sees. In SITL: scripts/sim-world.ts. On the rover: a perception service on the
// companion computer (camera colour detection, Ferret depth) serving the same /detections.

export interface Detection {
  kind: string;
  source: 'camera' | 'ferret';
  /** body frame, metres from the rover centre */
  forward_m: number;
  right_m: number;
  bearing_deg: number;
  range_m: number;
  confidence: number;
}

export interface PerceptionClient {
  detections(): Promise<Detection[]>;
}

export class HttpPerceptionClient implements PerceptionClient {
  private base: string;
  constructor(base = 'http://127.0.0.1:8766') {
    this.base = base.replace(/\/$/, '');
  }
  async detections(): Promise<Detection[]> {
    const res = await fetch(`${this.base}/detections`, { signal: AbortSignal.timeout(2000) });
    const d = (await res.json()) as { detections: Detection[] };
    return d.detections;
  }
}

/** No perception configured: sees nothing. */
export const blindPerception: PerceptionClient = { detections: async () => [] };
