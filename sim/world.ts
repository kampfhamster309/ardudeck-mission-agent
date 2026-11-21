// Simulated world for SITL: red balls on the field, a camera and a depth-camera model, and
// simple pushing physics. Pure logic (no I/O), driven by the rover pose from SITL.
//
// Frames: world = local metres east/north of an origin; rover body = forward/right of the rover
// centre; heading in degrees clockwise from north.

export interface SimBall { id: string; east: number; north: number; r: number }
export interface Pose { east: number; north: number; heading_deg: number; speed: number }

export interface Detection {
  /** what the detector thinks it is */
  kind: 'red_ball';
  source: 'camera' | 'ferret';
  /** body frame, metres from the rover centre */
  forward_m: number;
  right_m: number;
  /** degrees, + to the right of the rover's heading */
  bearing_deg: number;
  range_m: number;
  confidence: number;
}

export interface WorldConfig {
  rover: { length_m: number; width_m: number };
  plow: { fitted: boolean; width_m: number; depth_m: number };
  camera: { hfov_deg: number; min_m: number; max_m: number; bearing_noise_deg: number; range_noise_frac: number; p_detect: number };
  ferret: { enabled: boolean; hfov_deg: number; min_m: number; max_m: number; noise_m: number; back_offset_m: number };
  seed: number;
}

export const DEFAULT_CONFIG: WorldConfig = {
  rover: { length_m: 0.45, width_m: 0.35 }, // unmeasured on the real rover: a guess
  plow: { fitted: true, width_m: 0.3, depth_m: 0.12 },
  // C270: 55° diagonal -> ~45° horizontal at 4:3. Ground footprint starts ~0.5 m ahead at a
  // downward tilt; a 60 mm ball is a few pixels at 6 m.
  camera: { hfov_deg: 45, min_m: 0.5, max_m: 6, bearing_noise_deg: 2, range_noise_frac: 0.1, p_detect: 0.9 },
  // Ferret: 150-700 mm, ~68° horizontal; mounted this far behind the front edge so it can
  // see into the plow mouth (balls there are < 150 mm from the front edge).
  ferret: { enabled: true, hfov_deg: 68, min_m: 0.15, max_m: 0.7, noise_m: 0.005, back_offset_m: 0.2 },
  seed: 1,
};

/** Small deterministic PRNG (mulberry32) so runs are repeatable. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function toBody(pose: Pose, east: number, north: number) {
  const h = rad(pose.heading_deg);
  const de = east - pose.east;
  const dn = north - pose.north;
  return { forward: de * Math.sin(h) + dn * Math.cos(h), right: de * Math.cos(h) - dn * Math.sin(h) };
}

export function toWorld(pose: Pose, forward: number, right: number) {
  const h = rad(pose.heading_deg);
  return { east: pose.east + forward * Math.sin(h) + right * Math.cos(h), north: pose.north + forward * Math.cos(h) - right * Math.sin(h) };
}

export class World {
  balls: SimBall[];
  cfg: WorldConfig;
  private rand: ReturnType<typeof rng>;

  constructor(balls: SimBall[], cfg: WorldConfig = DEFAULT_CONFIG) {
    this.balls = balls.map((b) => ({ ...b }));
    this.cfg = cfg;
    this.rand = rng(cfg.seed);
  }

  /** Push balls out of the rover body, carry them in the plow mouth, deflect them off a bare front. */
  step(pose: Pose): void {
    const { length_m: L, width_m: W } = this.cfg.rover;
    const front = L / 2;
    const plow = this.cfg.plow;
    for (const b of this.balls) {
      let { forward: x, right: y } = toBody(pose, b.east, b.north);
      const r = b.r;
      // generous catch zone: telemetry arrives at a few Hz, so the rover can move several cm
      // between two poses and must not "tunnel" past a ball it is pushing
      if (plow.fitted && x > front - Math.max(r, 0.15) && x < front + plow.depth_m && Math.abs(y) < plow.width_m / 2) {
        // inside the U: back wall at the front edge, arms at +-width/2
        x = Math.max(x, front + r);
        const lim = plow.width_m / 2 - r;
        y = Math.max(-lim, Math.min(lim, y));
      } else if (Math.abs(y) < W / 2 + r && x > -L / 2 - r && x < front + r) {
        // touching the body or the bare front
        if (x > front - r * 0.5 && pose.speed > 0.02 && Math.abs(y) < W / 2) {
          // pushed by a flat front: forward, and a round ball slides off to the side
          const side = y === 0 ? (this.rand.next() < 0.5 ? -1 : 1) : Math.sign(y);
          x = front + r;
          y += side * Math.max(0.01, 0.4 * pose.speed * 0.1);
        } else {
          // pushed out sideways
          y = Math.sign(y || 1) * (W / 2 + r);
        }
      } else {
        continue;
      }
      const w = toWorld(pose, x, y);
      b.east = w.east;
      b.north = w.north;
    }
  }

  detections(pose: Pose): Detection[] {
    const out: Detection[] = [];
    const { camera: cam, ferret: fer } = this.cfg;
    const front = this.cfg.rover.length_m / 2;
    for (const b of this.balls) {
      const { forward: x, right: y } = toBody(pose, b.east, b.north);
      const range = Math.hypot(x, y);
      const bearing = deg(Math.atan2(y, x));
      // camera at the rover centre
      if (x > 0 && Math.abs(bearing) <= cam.hfov_deg / 2 && range >= cam.min_m && range <= cam.max_m && this.rand.next() < cam.p_detect) {
        const rr = range * (1 + cam.range_noise_frac * this.rand.gauss());
        const bb = bearing + cam.bearing_noise_deg * this.rand.gauss();
        out.push({ kind: 'red_ball', source: 'camera', range_m: rr, bearing_deg: bb, forward_m: rr * Math.cos(rad(bb)), right_m: rr * Math.sin(rad(bb)), confidence: 0.8 });
      }
      // ferret at the front, set back so it sees into the plow mouth
      if (fer.enabled) {
        const fx = x - (front - fer.back_offset_m);
        const fr = Math.hypot(fx, y);
        const fb = deg(Math.atan2(y, fx));
        if (fx > 0 && Math.abs(fb) <= fer.hfov_deg / 2 && fr >= fer.min_m && fr <= fer.max_m) {
          const nx = x + fer.noise_m * this.rand.gauss();
          const ny = y + fer.noise_m * this.rand.gauss();
          out.push({ kind: 'red_ball', source: 'ferret', forward_m: nx, right_m: ny, range_m: Math.hypot(nx, ny), bearing_deg: deg(Math.atan2(ny, nx)), confidence: 0.98 });
        }
      }
    }
    return out;
  }
}
