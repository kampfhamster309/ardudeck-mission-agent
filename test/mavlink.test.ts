// Run: node --test test/   (Node 22 strips the types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encodeV2, setpointPayload, MSG } from '../src/main/mavlink.ts';
import { motionRefusal } from '../src/main/gate.ts';

// Reference frames from pymavlink (MAVLink 2, seq 0, sysid 255, compid 191).
const PYMAVLINK_VEL = process.env['PYMAVLINK_VEL'];
const PYMAVLINK_POS = process.env['PYMAVLINK_POS'];

const vel = () => encodeV2(MSG.SET_POSITION_TARGET_LOCAL_NED, setpointPayload(84, {
  targetSystem: 1, targetComponent: 1, frame: 9, typeMask: 1479,
  x: 0, y: 0, z: 0, vx: 1.0, vy: 0, vz: 0, yaw: 0, yawRate: 0.5,
}), 0, 255, 191);
const pos = () => encodeV2(MSG.SET_POSITION_TARGET_GLOBAL_INT, setpointPayload(86, {
  targetSystem: 1, targetComponent: 1, frame: 6, typeMask: 3576,
  x: -353632610, y: 1491652300, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, yawRate: 0,
}), 0, 255, 191);

test('velocity setpoint matches pymavlink', { skip: !PYMAVLINK_VEL }, () => {
  assert.equal(Buffer.from(vel()).toString('hex'), PYMAVLINK_VEL);
});

test('position setpoint matches pymavlink', { skip: !PYMAVLINK_POS }, () => {
  assert.equal(Buffer.from(pos()).toString('hex'), PYMAVLINK_POS);
});

test('decode round-trips and rejects a bad checksum', () => {
  const f = vel();
  const [d] = decode(f);
  assert.equal(d!.msgid, 84);
  assert.equal(d!.payload.getFloat32(16, true), 1.0);
  assert.equal(d!.payload.getUint16(48, true), 1479);
  const bad = Uint8Array.from(f);
  bad[bad.length - 1] ^= 0xff;
  assert.equal(decode(bad).length, 0);
});

const host = { connected: true, sysid: 1, armed: true, guided: false, vehicleClass: 'other' as const, ardupilot: true };
const hb = (o: Partial<{ customMode: number; mavType: number; autopilot: number; armed: boolean; at: number }>) =>
  new Map([[1, { at: 1000, customMode: 15, mavType: 10, autopilot: 3, armed: true, ...o }]]);

test('gate', () => {
  assert.equal(motionRefusal({ now: 1000, heartbeats: hb({}), host }), null);
  assert.equal(motionRefusal({ now: 1000, heartbeats: hb({ armed: false }), host }), 'vehicle is not armed');
  assert.equal(motionRefusal({ now: 1000, heartbeats: hb({ customMode: 4 }), host }), 'vehicle is not in Guided mode');
  assert.equal(motionRefusal({ now: 1000, heartbeats: hb({ mavType: 2 }), host }), 'vehicle type not supported');
  assert.equal(motionRefusal({ now: 1000, heartbeats: hb({ autopilot: 12 }), host }), 'only ArduPilot vehicles can be steered');
  assert.equal(motionRefusal({ now: 5000, heartbeats: hb({}), host }), 'no vehicle on the agent link');
  assert.equal(motionRefusal({ now: 1000, heartbeats: hb({}), host: { ...host, connected: false } }), 'Ardudeck is not connected to a vehicle');
  assert.equal(motionRefusal({ now: 1000, heartbeats: hb({}), host: { ...host, sysid: 2 } }), 'no vehicle on the agent link');
});
