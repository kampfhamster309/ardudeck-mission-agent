# ardudeck-mission-agent

An add-on module for the [Ardudeck](https://github.com/rubenCodeforges/ardudeck) ground station
that lets an agent plan and drive missions for a tracked ArduRover UGV (the jetrover), next to
Ardudeck's regular mission planning.

Status: early. Planning, compiling and executing missions work end to end in ArduRover SITL
from the command line, including a red-ball mission (survey, approach, push each ball into a
corner, verify) against a simulated world. Still to come: the planning panel inside Ardudeck,
real perception on the rover, gimbal panning.

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

Ardudeck watches the folder and reloads the module's panel when `dist/` changes, but **not its
main side** (Node caches the import): after changing `src/main/`, restart Ardudeck. On Linux, Electron's
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
| `POST /goto` | `{"lat": .., "lon": .., "speed": 0.5}` or `{"north": 10, "east": 5}` | Guided position target, absolute or metres from the current position; optional ground speed in m/s (`DO_CHANGE_SPEED`, sent right after the target; if the vehicle refuses it, the rover is stopped) |
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
node scripts/plan.ts compile red-balls                # approved plan -> spec.yaml + spec.md, or blockers
```

The operator can also settle things the planner can't:

```sh
node scripts/plan.ts waive red-balls v3 "why the finding doesn't apply"     # until the next validation
node scripts/plan.ts provide red-balls "track width" "measured 350 mm"      # a configuration need is met
node scripts/plan.ts restore red-balls 5                                     # back to round 5 (rounds/round-N.json)
```

A waived error no longer blocks approval; `provide` marks a configuration need as available
(an approved plan goes back to draft). Both are logged in the plan's history, and both come back
in the spec's pre-flight checklist ("check what you vouched for", "does the waiver still
hold?"), to be checked against the real vehicle before the handover. They are the operator's
word, not evidence: in the first full simulation two of three waivers turned out wrong.

### Addons: designed with SolidCraft

When the plan needs an attachment the rover doesn't have (a plow, a bracket), the designer
builds it with SolidCraft's MCP server (`solidcraft-cli mcp`):

```sh
node scripts/plan.ts design red-balls                  # design missing attachments
node scripts/plan.ts design red-balls "push pan" "note" # design one named need, whatever its status
node scripts/plan.ts design-replay red-balls front_plow # rebuild from the transcript, no LLM
node scripts/plan.ts fit red-balls ../missions/red-balls/addons/front_plow.json   # it's fitted: add to MISSION_CAPS
```

Two phases: the model first writes a construction plan (key numbers, build stages with the
expected volume and bounding box) from a brief made of the plan's need, the rover's front
mount and the sensors' fields of view; then it builds the part stage by stage with the
SolidCraft tools, checking each stage (screenshots included), and submits the functional
dimensions and what it blocks. SolidCraft then measures the result (overall size, each body as
a printed part against the print bed), and STEP, STL and the `.sc` design go to
`<mission>/addons/`. `fit` copies the design into the capability model as a verified
attachment.

To watch the part being built, start SolidCraft with `solidcraft --control 7878` and set
`SOLIDCRAFT_CONNECT=127.0.0.1:7878`; otherwise the MCP server may build headless (it says so in
the log, and `design-replay` can rebuild the part in the app later).

`node scripts/plan.ts operator <id> <facts.md>` lets a simulated operator answer open
questions from a fact sheet (for unattended test runs).

### Full simulation

`scripts/sim-setup.ts <id> [--neutral]` writes a mission's simulation inputs to
`<missions>/<id>/sim/`: the capability model with SITL overrides (no attachments fitted), the
sites (a lawn around the SITL home) and the operator's fact sheet. A full run: `new` with the
mission request, `operator` / `update` rounds until there are no errors, `design`, `fit`,
`approve`, `compile`, then the SITL run below with `sim-world.ts --addon <design.json>` so the
simulated plow has the designed geometry. `--neutral` (with `MISSION_PROMPTS=prompts-neutral`
and `MISSION_ATTACHMENTS=neutral`) removes every hint about plows and pushing from the prompts
and the capability model, to see what the agents come up with on their own.

| Variable | Default | |
|---|---|---|
| `MISSION_LLM_URL` | (required) | OpenAI-compatible base URL, ending in `/v1` |
| `MISSION_LLM_MODEL` | (required) | model id |
| `MISSION_LLM_KEY` | | bearer token, if the server needs one |
| `MISSION_LLM_MAX_TOKENS` | `65536` | answer limit per request (reasoning models think before calling a tool) |
| `MISSION_CAPS` | `../rover/capabilities.yaml` | rover capability model |
| `MISSION_SITES` | `../rover/sites.yaml` | named places (optional) |
| `MISSION_DIR` | `../missions` | where plans are stored |
| `MISSION_LLM_REASONING_EFFORT` | server default | `reasoning_effort` per request; when a model thinks through the whole answer limit without answering, the request is repeated one level lower (down to `medium`) |
| `MISSION_LLM_TIMEOUT_S` | answer limit / 20 + 300 | per-request timeout |
| `MISSION_LLM_CONTEXT` | `1000000` | context window, for the token log |
| `MISSION_DESIGN_PLAN_MAX_TOKENS` | `65536` | the designer's construction-plan request |
| `MISSION_DESIGN_PLAN_EFFORT` | `high` | its reasoning effort |
| `MISSION_DESIGNER_VISION` | `1` | `0`: the designer gets no screenshots |
| `MISSION_PRINT_BED_MM` | `220x220x250` | the printer's build volume, for checking the parts |
| `MISSION_ATTACHMENTS` | `keywords` | which missing needs go to the designer: named add-ons, or `neutral` (every need nothing on the rover provides) |
| `MISSION_VAULT` | `~/vaults/jetrover` | the experience vault for the planner, validator and debrief; `off` disables it |
| `MISSION_PROMPTS` | `prompts/` | folder with the agents' prompts |
| `SOLIDCRAFT_CONNECT` | | `host:port` of a running SolidCraft (`--control`) |

Paths are relative to this repo. Each mission gets a folder with `plan.json` (the stored
plan), `plan.md` (readable view), `rounds/` (a snapshot per round), `transcripts/` (the model
conversations, for debugging) and `usage.jsonl` (tokens and time per request; each step prints
its totals).

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

### The mission spec

Approving a plan means "we agree on this mission". Compiling it means "it can run now":
`compile` turns an approved plan into the frozen, executable **mission spec**, in code, without
the LLM. It refuses with a list of blockers while anything can't run on the rover today:
behaviours that aren't `verified`, configuration needs that are missing or unknown, unresolved
coordinates or placeholder parameters, phases faster than the speed limit, or vehicle
preconditions not met (motors on the Pixhawk, `FS_GCS_ENABLE=1`, battery monitoring when a
battery abort is planned).

The spec comes in two forms: `spec.yaml` for the executor, and `spec.md`, a one-page briefing
for the LLM at decision points. It records the plan round and a hash of the plan content it
was compiled from, and each step names the success criteria it serves, so a mission log can be
scored against them.

Site and target names are resolved from the sites file (`../rover/sites.yaml`): named areas
with a boundary polygon (used as the geofence) and named points, as `[lat, lon]`. See
`rover/sites.example.yaml` in the jetrover project for the format.

### Running a mission

`scripts/run.ts` executes a compiled spec through the control port (Ardudeck running, module
loaded, connected to the vehicle):

```sh
node scripts/run.ts red-balls [--from p3] [--agent http://127.0.0.1:8765] [--no-llm]
```

* Refuses a spec whose plan changed after compiling, or a plan that is no longer approved.
* Prints the operator's pre-flight checklist and which abort conditions it watches itself
  (geofence, mission time, overspeed, stale telemetry / link) and which it can't.
* Starts when the operator arms and switches to GUIDED; pauses whenever the rover isn't
  drivable (operator took over, link lost) and restarts the interrupted step after the
  handback; aborts after a 10-minute pause.
* Each step runs its behaviour with built-in completion and a timeout:

  | Behaviour | Does |
  |---|---|
  | `goto` | drive to a point at no more than the speed limit; stops as soon as it is within the arrival radius (2 m; a stand-off), closing the last stretch with velocity if the vehicle parks short (its WP_RADIUS is wider); routes around keep-out zones |
  | `velocity` | body speed and turn rate for a duration |
  | `stop` | zero velocity |
  | `survey` | lawnmower legs inside the geofence, spread evenly from one inset edge to the other and at most `spacing_m` apart (2 m: the camera looks forward only), mapping camera detections up to `register_max_m` (6 m) to objects, but not while the rover turns faster than 20°/s; keeps out of the target zone, sidesteps known objects, registers a ball it scoops up; `mode: verify` fails if anything is outside the target zone |
  | `hold_and_look` | turn in place and look around |
  | `approach` | drive to the current object: stand-off point behind it (seen from `align_to`), then camera visual servoing, the Ferret for the last 0.7 m (without it, the last stretch is dead-reckoned); an object not seen during the approach is first searched for with one turn on the spot (within 3 m of where it was mapped: far sightings can be metres off, a deflected ball may lie beside the rover), and only then dismissed as moved or a false sighting |
  | `push_to` | push the object in the plow mouth to a target, turning gently; fails if the Ferret sees the ball leave the plow |
  | `back_off` | reverse (1 m by default) |

* Steps with `for_each: object` and the same `block` run once per found object, nearest first
  (approach, push, back off per ball). Inside a block, a retry starts the block again for the
  same object and a skip moves on to the next one.
* Perception comes from `--perception` (default `http://127.0.0.1:8766`, `GET /detections`):
  in SITL the simulated world, on the rover a perception service serving the same thing.
* When a step fails, the rover is stopped and the LLM decides (`prompts/decision.md`, with the
  spec briefing as context): retry, skip, hold for the operator, or abort. Retries are capped
  (2 by default); without an answer or with `--no-llm` the mission holds. Continue a held
  mission with `--from <step>`.
* Logs every event to `<missions>/<id>/runs/<timestamp>/events.jsonl` and the outcome, per step
  and per success criterion, to `result.json`. A resumed run (`--from`) scores the success
  criteria over itself and the earlier runs it continues.

`scripts/sitl-mission.ts` builds, approves and compiles test missions for ArduRover SITL
without the LLM: `sitl-square` (three corners of a 15 m square, a turn in place, home) and
`sitl-balls` (find the balls, push each into the corner, verify, home).

`scripts/sim-world.ts` is the simulated world for SITL (`sim/world.ts`): red balls, a camera
model (45° horizontal, 0.5-6 m, noise, misses), a Ferret model (0.15-0.7 m, sees into the plow
mouth; `--no-ferret`) and pushing physics with or without a plow (`--no-plow`). It follows the
rover through the control port and serves `GET /detections`, `GET /world` (ground truth, with
each ball's distance from the drop corner) and `POST /reset`.

### Experience vault and debrief

Lessons from mission runs live in an Obsidian-compatible git vault (`MISSION_VAULT`, default
`~/vaults/jetrover`; `off` disables it). Its `VAULT-INDEX.md` holds the map and the rules.

- The planner and validator get `vault_search` and `vault_read` and see only accepted notes
  (`status: active`). Each lesson says whether it was learned in the simulator or on the real
  rover (`environment: sim | real`) and links the runs that show it.
- After a run, the debrief writes a run report to `Runs/` and proposes lessons in `Rover/`,
  `Behaviours/`, `Sites/` and `Strategy/`. Everything it writes is `status: proposed`; an edit
  of an existing note goes to `Proposals/` with `edit_of:`. It commits in the vault.
- The operator accepts a lesson in Obsidian by setting it to `active`, or merges the proposed
  edit. Agents never mark a lesson active.
- A lesson that is a hard fact about the vehicle belongs in the capability model too, with the
  note as its `source`, so the validator enforces it.

```sh
node scripts/debrief.ts sim-red-balls --world http://127.0.0.1:8766 --note "what I saw"
```

It takes the latest run by default (or a run folder name), and includes the earlier runs a
resumed run continues. `--world` adds the simulator's ground truth; `--env sim|real` overrides
the environment, which otherwise is `sim` when `--world` is given or `MISSION_CAPS` points into
a `sim/` folder. `--no-commit` leaves the vault uncommitted.

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
| `src/planning/` | plan format, checks, LLM client, planner and validator, spec compiler, addon designer, MCP client, simulated operator |
| `prompts/` | planner, validator, designer, decision and debrief prompts |
| `prompts-neutral/` | the same without hints about plows and pushing |
| `src/executor/` | mission executor, behaviours, control-port and perception clients, LLM decision point |
| `sim/world.ts` | simulated world: balls, camera and Ferret models, plow physics |
| `scripts/sim-world.ts` | serves the simulated world for SITL |
| `scripts/plan.ts` | planning CLI |
| `scripts/run.ts` | executes a compiled mission |
| `scripts/debrief.ts` | debriefs a run into the experience vault |
| `src/vault/` | experience vault search/read, the debrief agent |
| `scripts/sitl-mission.ts` | builds the SITL test mission |
| `scripts/sim-setup.ts` | writes a mission's full-simulation inputs |
| `esbuild.config.mjs` | builds `dist/` |
