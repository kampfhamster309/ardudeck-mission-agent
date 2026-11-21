// The module's motion gate for its own MAVLink link. Mirrors Ardudeck's host gate
// (vehicle-control.ts: ArduPilot, armed, Guided, fresh heartbeat) for ArduRover, and adds one
// rule: Ardudeck must be connected to the same vehicle, so the operator sees what's happening.

import type { GuidedState } from '@ardudeck/module-sdk';
import type { Heartbeat } from './mavlink.js';

export const HEARTBEAT_STALE_MS = 3000;
export const MAV_AUTOPILOT_ARDUPILOTMEGA = 3;
export const ROVER_TYPES = new Set([10, 11]); // GROUND_ROVER, SURFACE_BOAT (both ArduRover)
export const ROVER_GUIDED = 15;

export interface GateInput {
  now: number;
  /** Heartbeats seen on the module's own link, by sysid. */
  heartbeats: Map<number, Heartbeat>;
  /** What Ardudeck sees on its own connection. */
  host: GuidedState;
}

/** Why the rover may not be moved over the module's own link, or null when it may. */
export function motionRefusal({ now, heartbeats, host }: GateInput): string | null {
  if (!host.connected || host.sysid === null) return 'Ardudeck is not connected to a vehicle';
  const hb = heartbeats.get(host.sysid);
  if (!hb || now - hb.at > HEARTBEAT_STALE_MS) return 'no vehicle on the agent link';
  if (hb.autopilot !== MAV_AUTOPILOT_ARDUPILOTMEGA) return 'only ArduPilot vehicles can be steered';
  if (!ROVER_TYPES.has(hb.mavType)) return 'vehicle type not supported';
  if (!hb.armed) return 'vehicle is not armed';
  if (hb.customMode !== ROVER_GUIDED) return 'vehicle is not in Guided mode';
  return null;
}
