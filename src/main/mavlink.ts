// Minimal MAVLink (v1 + v2) codec and UDP link for the few messages this module needs.
//
// Why it exists: Ardudeck's module API refuses motion commands for rovers (its vehicle gate only
// knows copters and planes), and we don't patch Ardudeck. So the module keeps its own standard
// MAVLink link to the vehicle (on the real rover: the Jetson bridge's spare output, UDP 14562)
// and applies the same gate itself (see gate.ts).

import { createSocket, type Socket } from 'node:dgram';

export const MSG = {
  HEARTBEAT: 0,
  GLOBAL_POSITION_INT: 33,
  VFR_HUD: 74,
  SET_POSITION_TARGET_LOCAL_NED: 84,
  SET_POSITION_TARGET_GLOBAL_INT: 86,
} as const;

const CRC_EXTRA: Record<number, number> = { 0: 50, 33: 104, 74: 20, 84: 143, 86: 5 };
const PAYLOAD_LEN: Record<number, number> = { 0: 9, 33: 28, 74: 20, 84: 53, 86: 53 };

export function crcX25(bytes: Uint8Array, crc = 0xffff): number {
  for (const b of bytes) {
    let tmp = (b ^ (crc & 0xff)) & 0xff;
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  }
  return crc;
}

export interface Frame { msgid: number; sysid: number; compid: number; payload: DataView }

/** Split a datagram into frames; drops frames with unknown ids or bad checksums. */
export function decode(buf: Uint8Array): Frame[] {
  const out: Frame[] = [];
  let i = 0;
  while (i < buf.length) {
    const magic = buf[i];
    if (magic === 0xfd && i + 10 <= buf.length) {
      const len = buf[i + 1]!;
      const signed = (buf[i + 2]! & 0x01) !== 0;
      const end = i + 10 + len + 2 + (signed ? 13 : 0);
      if (end > buf.length) break;
      const msgid = buf[i + 7]! | (buf[i + 8]! << 8) | (buf[i + 9]! << 16);
      const extra = CRC_EXTRA[msgid];
      if (extra !== undefined) {
        const crc = crcX25(Uint8Array.of(extra), crcX25(buf.subarray(i + 1, i + 10 + len)));
        const got = buf[i + 10 + len]! | (buf[i + 11 + len]! << 8);
        if (crc === got) out.push({ msgid, sysid: buf[i + 5]!, compid: buf[i + 6]!, payload: padded(buf.subarray(i + 10, i + 10 + len), msgid) });
      }
      i = end;
    } else if (magic === 0xfe && i + 6 <= buf.length) {
      const len = buf[i + 1]!;
      const end = i + 6 + len + 2;
      if (end > buf.length) break;
      const msgid = buf[i + 5]!;
      const extra = CRC_EXTRA[msgid];
      if (extra !== undefined) {
        const crc = crcX25(Uint8Array.of(extra), crcX25(buf.subarray(i + 1, i + 6 + len)));
        const got = buf[i + 6 + len]! | (buf[i + 7 + len]! << 8);
        if (crc === got) out.push({ msgid, sysid: buf[i + 3]!, compid: buf[i + 4]!, payload: padded(buf.subarray(i + 6, i + 6 + len), msgid) });
      }
      i = end;
    } else {
      i++;
    }
  }
  return out;
}

/** MAVLink 2 trims trailing zero bytes: pad back to the full length before reading offsets. */
function padded(p: Uint8Array, msgid: number): DataView {
  const full = new Uint8Array(Math.max(PAYLOAD_LEN[msgid] ?? 0, p.length));
  full.set(p);
  return new DataView(full.buffer);
}

export function encodeV2(msgid: number, payload: Uint8Array, seq: number, sysid: number, compid: number): Uint8Array {
  let len = payload.length;
  while (len > 1 && payload[len - 1] === 0) len--; // v2 payload truncation
  const frame = new Uint8Array(10 + len + 2);
  frame.set([0xfd, len, 0, 0, seq & 0xff, sysid, compid, msgid & 0xff, (msgid >> 8) & 0xff, (msgid >> 16) & 0xff]);
  frame.set(payload.subarray(0, len), 10);
  const crc = crcX25(Uint8Array.of(CRC_EXTRA[msgid]!), crcX25(frame.subarray(1, 10 + len)));
  frame[10 + len] = crc & 0xff;
  frame[11 + len] = crc >> 8;
  return frame;
}

export interface SetpointFields {
  typeMask: number;
  frame: number;
  targetSystem: number;
  targetComponent: number;
  /** LOCAL_NED: x, y, z in metres. GLOBAL_INT: lat/lon in degE7 (ints), alt in metres. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; yawRate: number;
}

/** SET_POSITION_TARGET_LOCAL_NED (84) or SET_POSITION_TARGET_GLOBAL_INT (86); same 53-byte layout. */
export function setpointPayload(msgid: 84 | 86, f: SetpointFields): Uint8Array {
  const b = new Uint8Array(53);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0, true); // time_boot_ms
  if (msgid === 86) {
    v.setInt32(4, f.x, true);
    v.setInt32(8, f.y, true);
  } else {
    v.setFloat32(4, f.x, true);
    v.setFloat32(8, f.y, true);
  }
  v.setFloat32(12, f.z, true);
  v.setFloat32(16, f.vx, true);
  v.setFloat32(20, f.vy, true);
  v.setFloat32(24, f.vz, true);
  // afx, afy, afz (28..39) stay 0
  v.setFloat32(40, f.yaw, true);
  v.setFloat32(44, f.yawRate, true);
  v.setUint16(48, f.typeMask, true);
  b[50] = f.targetSystem;
  b[51] = f.targetComponent;
  b[52] = f.frame;
  return b;
}

export interface Heartbeat { at: number; customMode: number; mavType: number; autopilot: number; armed: boolean }

/**
 * UDP link in "listen" mode, like Ardudeck's own UDP connection: binds a local port, learns the
 * vehicle's address from the first valid vehicle heartbeat, and only ever sends there.
 */
export class MavLink {
  private sock: Socket | null = null;
  private peer: { address: string; port: number } | null = null;
  private seq = 0;
  /** Latest heartbeat per vehicle sysid, from this link only. */
  readonly heartbeats = new Map<number, Heartbeat>();
  onFrame: ((f: Frame) => void) | null = null;
  error: string | null = null;

  private bindHost: string;
  private bindPort: number;
  private sysid: number;
  private compid: number;

  constructor(bindHost: string, bindPort: number, sysid = 255, compid = 191) {
    this.bindHost = bindHost;
    this.bindPort = bindPort;
    this.sysid = sysid;
    this.compid = compid;
  }

  get describe(): string {
    return `udp ${this.bindHost}:${this.bindPort}${this.peer ? ` <- ${this.peer.address}:${this.peer.port}` : ' (no vehicle yet)'}`;
  }

  open(log: (msg: string) => void): void {
    const sock = createSocket('udp4');
    sock.on('error', (err) => { this.error = err.message; log(`mavlink link: ${err.message}`); });
    sock.on('message', (msg, rinfo) => {
      for (const f of decode(msg)) {
        if (f.msgid === MSG.HEARTBEAT) {
          const mavType = f.payload.getUint8(4);
          if (mavType === 6) continue; // another GCS
          // Lock onto the first vehicle that talks to us; ignore other senders afterwards.
          if (!this.peer) {
            this.peer = { address: rinfo.address, port: rinfo.port };
            log(`mavlink link: vehicle at ${rinfo.address}:${rinfo.port}`);
          }
          if (rinfo.address !== this.peer.address || rinfo.port !== this.peer.port) continue;
          this.heartbeats.set(f.sysid, {
            at: Date.now(),
            customMode: f.payload.getUint32(0, true),
            mavType,
            autopilot: f.payload.getUint8(5),
            armed: (f.payload.getUint8(6) & 0x80) !== 0,
          });
        } else if (!this.peer || rinfo.address !== this.peer.address || rinfo.port !== this.peer.port) {
          continue;
        }
        this.onFrame?.(f);
      }
    });
    sock.bind(this.bindPort, this.bindHost, () => log(`mavlink link listening on ${this.bindHost}:${this.bindPort}`));
    this.sock = sock;
  }

  send(msgid: number, payload: Uint8Array): Promise<boolean> {
    const sock = this.sock;
    const peer = this.peer;
    if (!sock || !peer) return Promise.resolve(false);
    const frame = encodeV2(msgid, payload, this.seq++, this.sysid, this.compid);
    return new Promise((resolve) => sock.send(frame, peer.port, peer.address, (err) => resolve(!err)));
  }

  close(): void {
    this.sock?.close();
    this.sock = null;
  }
}
