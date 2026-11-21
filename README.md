# ardudeck-mission-agent

An add-on module for the [Ardudeck](https://github.com/rubenCodeforges/ardudeck) ground station
that lets an agent plan and drive missions for a tracked ArduRover UGV (the jetrover), next to
Ardudeck's regular mission planning.

Status: early. Driving works end to end in ArduRover SITL; mission planning works from the
command line. The planning panel inside Ardudeck, the remaining behaviours and perception are
still to come.

## What it does

* **Drives the rover with standard MAVLink, only in Guided.** Behaviours (`velocity`, `goto`,
  `stop`) send Guided setpoints, and only while the vehicle is ArduPilot, a rover, armed and in
  GUIDED, and Ardudeck is connected to the same vehicle. The operator hands over by switching to
  GUIDED and takes back by switching to anything else. Arming and mode changes stay with the
  operator.
* **Plans missions with an LLM.** A planner drafts a mission plan from a plain-language request,
  grounded in a rover capability model; a validator reports contradictions, gaps and things the
  rover can't do; the operator answers questions and approves.
* **Runs on stock Ardudeck.** Everything lives in this module, Ardudeck itself is not patched.

### Why the module has its own MAVLink link

Ardudeck's module API (`host.vehicle.setpoint`) only steers copters and planes and refuses
rovers. So the module listens for the vehicle on its own UDP port (default `0.0.0.0:14562`,
the same "listen" model as Ardudeck's UDP connection) and sends the setpoints there, behind the
same gate Ardudeck applies (see `src/main/gate.ts`). If a later Ardudeck version supports
rovers, the module uses `host.vehicle.setpoint` instead. ArduRover itself also ignores setpoints
outside Guided.

On the jetrover, the Jetson's MAVLink bridge already sends a copy of the vehicle's stream to
the ground station on port 14562, so no extra setup is needed there.

## Requirements

* Ardudeck run **from source** (dev modules only load in unpackaged builds)
* Node.js 22 (the CLI and tests run TypeScript directly) and pnpm
* For planning: an OpenAI-compatible chat endpoint with tool calling (llama.cpp, vLLM, Ollama, ...)
* The rover capability model, `../rover/capabilities.yaml` by default (see below)

## Build and load

```sh
pnpm install
pnpm run build          # -> dist/ (main.js, renderer.js, module.json)
```

Register `dist/` as a dev module in Ardudeck's `modules-dev.json` (in Ardudeck's settings
folder, `~/.config/@ardudeck/desktop/` on Linux), then start Ardudeck from source:

```json
{"devModules":[{"slug":"dev.jetrover.mission-agent","name":"Jetrover Mission Agent","version":"0.1.0","path":"/absolute/path/to/ardudeck-mission-agent/dist"}]}
```

Ardudeck watches the folder and reloads the module when `dist/` changes. On Linux, Electron's
`chrome-sandbox` in Ardudeck's `node_modules/electron/dist/` must be owned by root with mode
4755, or Ardudeck won't start.

Once loaded, the module shows a **Mission Agent** panel in Ardudeck's module dock: whether the
agent may drive (and why not), speed, heading, the running behaviour and a **Stop agent**
button.

## Control port

The module listens on `http://127.0.0.1:8765` (loopback only) for scripts and, later, the
agent:

| Request | Body | Does |
|---|---|---|
| `GET /status` | | gate state, why driving is refused, agent link, telemetry, running behaviour |
| `POST /velocity` | `{"forward": 1.0, "yawRate": 0, "seconds": 5}` | body-frame speed (m/s) and turn rate (rad/s) at 10 Hz |
| `POST /goto` | `{"lat": .., "lon": ..}` or `{"north": 10, "east": 5}` | Guided position target, absolute or metres from the current position |
| `POST /stop` | `{}` | cancels the running behaviour, sends zero velocity |

A new behaviour cancels the running one. Refusals come back as `{"error": "vehicle is not in
Guided mode"}` and the like.

Environment variables (set before starting Ardudeck):

| Variable | Default | |
|---|---|---|
| `JETROVER_AGENT_PORT` | `8765` | control port |
| `JETROVER_MAV_LISTEN` | `0.0.0.0:14562` | where the agent link listens for the vehicle |

Safety notes from SITL testing (ArduRover 4.7.3): velocity setpoints time out after 3 s and the
rover stops by itself; **position targets don't time out**, only ArduPilot's GCS failsafe stops
the rover on link loss. Set `FS_GCS_ENABLE=1` on the vehicle before letting the agent drive.

## Mission planning

Plans are drafted and checked from the command line until the Ardudeck panel exists:

```sh
export MISSION_LLM_URL=http://<host>:<port>/v1
export MISSION_LLM_MODEL=<model id>

node scripts/plan.ts new red-balls "Find all the red balls on the lawn and push them into one corner."
node scripts/plan.ts show red-balls
node scripts/plan.ts answer red-balls q2 "The north-east corner"
node scripts/plan.ts update red-balls                 # planner works the answers in, then validates
node scripts/plan.ts refine red-balls phases "Split it into a search-only mission first"
node scripts/plan.ts edit red-balls goal "My own words for the goal"
node scripts/plan.ts validate red-balls [--no-llm]
node scripts/plan.ts approve red-balls
```

| Variable | Default | |
|---|---|---|
| `MISSION_LLM_URL` | (required) | OpenAI-compatible base URL, ending in `/v1` |
| `MISSION_LLM_MODEL` | (required) | model id |
| `MISSION_LLM_KEY` | | bearer token, if the server needs one |
| `MISSION_LLM_MAX_TOKENS` | `65536` | answer limit per request (reasoning models think before calling a tool) |
| `MISSION_CAPS` | `../rover/capabilities.yaml` | rover capability model |
| `MISSION_SITES` | `../rover/sites.yaml` | named places (optional) |
| `MISSION_DIR` | `../missions` | where plans are stored |

Paths are relative to this repo. Each mission gets a folder with `plan.json` (the stored
plan), `plan.md` (readable view) and `transcripts/` (the model conversations, for debugging).

### The plan

Six fixed sections, each with prose (the reasoning) and structured items (the data a later step
executes): **goal**, **success criteria** (each says how it's measured), **area and limits**
(geofence, no-go zones, speed and time limits, targets), **rover configuration** (what the
mission needs and whether the rover has it), **phases** (behaviour, parameters, exit condition,
failure action) and **abort and safety**.

Rules, adapted from [Lore](https://github.com/re-cinq/lore)'s feature planning and enforced in
code (`src/planning/plan.ts`):

* the planner never overwrites what the operator wrote, it can only add to it;
* questions are the operator's: the planner adds them, never edits or removes them; answered
  questions are settled decisions the planner must write in;
* every validation pass replaces the findings, so a finding clears once its cause is gone;
* a plan can only be approved with every section written, every question answered and no
  error finding.

Findings come from two places: fixed checks in code (`src/planning/checks.ts`) and the LLM
validator (`prompts/validator.md`), which spends its effort on contradictions and on what the
rover can't actually do according to the capability model.

The two prompts are adapted from Lore's
[`plan-analyze.md`](https://github.com/re-cinq/lore/blob/main/libs/shared/src/agent-defaults/plan-analyze.md)
(planner) and
[`plan-validate.md`](https://github.com/re-cinq/lore/blob/main/libs/shared/src/agent-defaults/plan-validate.md)
(validator), reworked for missions: grounded in the capability model instead of a code
repository, and with coordinates, distances and speeds as the content rather than kept out.

### The capability model

`rover/capabilities.yaml` (in the jetrover project, outside this repo) describes the rover:
chassis, drive, power, compute, links, sensors with their limits, actuators, fitted
attachments, relevant vehicle parameters and the available behaviours. Every value carries a
`status` (`verified`, `measured`, `configured`, `spec`, `planned`, `unknown`) and a `source`.
It's the only thing the planner and validator may treat as true about the rover.

## Tests

```sh
pnpm exec tsc --noEmit
pnpm test
```

The MAVLink encoder can be checked byte-for-byte against pymavlink by passing reference frames
in `PYMAVLINK_VEL` / `PYMAVLINK_POS` (see `test/mavlink.test.ts`); without them those two tests
are skipped.

## Layout

| Path | What |
|---|---|
| `module.json` | Ardudeck module manifest (`vehicleControl`, `network` permissions) |
| `src/main/index.ts` | main side: control port, behaviours, setpoint routing |
| `src/main/mavlink.ts` | minimal MAVLink v1/v2 codec and UDP link for the agent |
| `src/main/gate.ts` | when the agent may move the rover |
| `src/renderer/index.tsx` | status panel |
| `src/planning/` | plan format, checks, LLM client, planner and validator |
| `prompts/` | planner and validator prompts |
| `scripts/plan.ts` | planning CLI |
| `esbuild.config.mjs` | builds `dist/` |
