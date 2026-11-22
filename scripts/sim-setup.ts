#!/usr/bin/env node
// Set up the full-simulation scenario: a mission folder with its own capability model (the real
// one plus SITL/simulated-world overrides, NO plow fitted), a sites file for the SITL lawn, and
// a fact sheet for the simulated operator.
//
//   node scripts/sim-setup.ts [id] [--neutral]
//       -> <missions>/<id>/sim/{capabilities.yaml,sites.yaml,operator.md}
//   --neutral: no hints about the expected solution (no "needs a front plow", no pushing words)
//
// Then plan with MISSION_CAPS / MISSION_SITES pointing at those files (see README, "Full simulation").

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as toYaml } from 'yaml';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const capsPath = resolve(repo, '../rover/capabilities.yaml');
const missionDir = resolve(repo, process.env['MISSION_DIR'] ?? '../missions');
const neutral = process.argv.includes('--neutral');
const id = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'sim-red-balls';
const dir = join(missionDir, id, 'sim');
mkdirSync(dir, { recursive: true });

const HOME: [number, number] = [-35.363261, 149.16523]; // ArduPilot SITL default
const at = (east: number, north: number): [number, number] => [
  +(HOME[0] + north / 111_320).toFixed(7),
  +(HOME[1] + east / (111_320 * Math.cos((HOME[0] * Math.PI) / 180))).toFixed(7),
];
const SIM = 'simulation (ArduRover SITL + scripts/sim-world.ts)';

const c = parseYaml(readFileSync(capsPath, 'utf-8')) as Record<string, any>;

c.chassis.turns_in_place = { value: true, status: 'verified', source: SIM };
c.chassis.footprint_length_mm = { value: 450, status: 'verified', source: SIM };
c.chassis.footprint_width_mm = { value: 350, status: 'verified', source: SIM };
c.chassis.height_mm = { value: 300, status: 'verified', source: SIM };
c.chassis.ground_clearance_mm = { value: 30, status: 'verified', source: SIM };
c.chassis.max_speed_mps = { value: 1.0, status: 'verified', source: SIM };
c.chassis.front_mount = {
  value: 'flat front face, 350 mm wide x 60 mm tall, lower edge 15 mm above the ground; four M3 threaded holes at x = -60 / +60 mm from the centre line, 25 and 50 mm above the ground. Body frame: x forward, y left, z up, origin at the centre of the front face on the ground.',
  status: 'verified', source: SIM,
};
c.drive.pixhawk_wiring = { value: 'simulated', status: 'verified', source: SIM };
c.drive.driven_by_pixhawk = { value: true, status: 'verified', source: SIM };
c.power.battery_monitoring = { value: true, status: 'verified', source: 'SITL simulated battery' };
c.power.runtime_min_driving = { value: 60, status: 'verified', source: SIM };
c.sensors.gps.fitted = { value: true, status: 'verified', source: 'SITL GPS' };
c.sensors.gps.horizontal_accuracy_m = { value: 0.3, status: 'verified', source: 'SITL GPS' };
c.sensors.lidar_ld19.mount_height_mm = { value: 200, status: 'verified', source: SIM };
c.sensors.lidar_ld19.blocked_sectors = { value: [], status: 'verified', source: SIM };
c.sensors.camera_c270.mount_height_mm = { value: 250, status: 'verified', source: SIM };
c.sensors.camera_c270.detection = {
  value: 'red-ball detection by the perception service: body-frame positions, 0.5-6 m, about 10 % range and 2 deg bearing noise, ~90 % per frame; camera looks straight ahead (45 deg horizontal), gimbal panning not used',
  status: 'verified', source: SIM,
};
c.sensors.depth_ferret_pro.status = 'verified';
c.sensors.depth_ferret_pro.source = SIM;
c.sensors.depth_ferret_pro.mount = {
  value: 'centred, 200 mm behind the front face, looking forward and down: sees objects 150-700 mm from its lens, i.e. from about 50 mm behind to 500 mm in front of the front face',
  status: 'verified', source: SIM,
};
c.compute.companion.current = { value: 'simulated perception service on the ground station', status: 'verified', source: SIM };
c.vehicle_config.fs_gcs_enable = { value: 1, status: 'configured', source: 'SITL' };
c.vehicle_config.fence_enable = { value: 1, status: 'configured', source: 'SITL; the operator applies the mission fence' };
for (const b of ['survey', 'hold_and_look', 'approach', 'push_to', 'back_off']) {
  const { sitl: _s, ...rest } = c.behaviours[b];
  c.behaviours[b] = { ...rest, status: 'verified', source: SIM };
}
c.execution = {
  value: 'Steps run in order. Consecutive steps with params for_each: object and the same params block run once per object the surveys found, nearest first (e.g. approach -> push_to -> back_off per ball). Behaviours get places as target names from the sites (e.g. target: ne_corner).',
  status: 'verified', source: 'ardudeck-mission-agent executor',
};
c.attachments = [];
if (neutral) {
  // describe what things do, not what the expected solution is
  c.behaviours.push_to = { ...c.behaviours.push_to, needs: ['approach'], does: "moves the current object to a target by driving against it with the rover's front" };
  c.behaviours.approach.needs = ['camera detection', 'depth_ferret_pro for the last 0.7 m (camera-only fallback dead-reckons)'];
  c.sensors.depth_ferret_pro.role = 'close work only (measure distances, gaps, steps at 150-700 mm); never search';
  c.vehicle_config.avoidance.todo = String(c.vehicle_config.avoidance.todo).replace('(plow, boxes)', '(close to objects)');
  c.execution.value = String(c.execution.value).replace('(e.g. approach -> push_to -> back_off per ball)', '(the same steps for each object found)');
}

const header = `# SIMULATION capability model for mission ${id}: the real rover/capabilities.yaml with the
# parts the simulation provides (ArduRover SITL, simulated camera detection and Ferret, physics,
# a defined front mount). No attachments fitted. Generated by scripts/sim-setup.ts${neutral ? ' --neutral' : ''}.
`;
writeFileSync(join(dir, 'capabilities.yaml'), header + toYaml(c, { lineWidth: 110 }));

const sites = {
  sites: {
    lawn: {
      note: 'simulated lawn on the SITL field, 14 x 14 m; corners are named 1 m inside the boundary',
      polygon: [at(-2, -2), at(12, -2), at(12, 12), at(-2, 12)],
      points: { start_home: at(0, 0), ne_corner: at(11, 11), nw_corner: at(-1, 11), se_corner: at(11, -1), sw_corner: at(-1, -1) },
    },
  },
};
writeFileSync(join(dir, 'sites.yaml'), toYaml(sites));

writeFileSync(join(dir, 'operator.md'), `# What the (simulated) operator knows

You play the rover's operator in a simulation (ArduRover SITL with a simulated world). Answer the
planner's questions from these facts. Answer briefly, in plain words.

* The place is the site "lawn"; the rover starts at "start_home".
* The balls go into the north-east corner of the lawn ("ne_corner").
* "In the corner" means within 1.5 m of ne_corner.
* There are a few red balls, probably three, each about 60 mm across. The exact count is unknown.
* Nothing else is on the lawn: no hose, no flowerbeds, no people or animals during the mission.
* Light is even (overcast); the camera and the Ferret both work.
* Speed up to 0.5 m/s is fine. The time budget is 40 minutes.
* No attachment is fitted to the rover today. If the plan says the rover needs one, agree: it
  will be designed (SolidCraft), printed and fitted before the mission. The front mount is the
  one in the capability model (chassis.front_mount).
* Arming, switching to GUIDED and applying fence proposals are done by you, the operator.

If a question asks for something these facts don't cover, say you don't know and accept the
planner's suggested answer, unless it contradicts a fact above.
`);

console.log(`wrote ${dir}/{capabilities.yaml,sites.yaml,operator.md}`);
console.log(`export MISSION_CAPS=${join(dir, 'capabilities.yaml')} MISSION_SITES=${join(dir, 'sites.yaml')}`);
