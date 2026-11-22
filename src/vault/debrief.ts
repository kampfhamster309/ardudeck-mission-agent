// Post-run debrief: an LLM reads what a mission run did (spec, events, result, ground truth when
// simulated, the operator's remarks) and the experience vault, then writes a run report and
// proposes lessons. Everything it writes is `status: proposed`; the operator accepts a lesson in
// Obsidian by setting it to `active` (or merging a proposed edit into its note). Agents never
// mark lessons active: a wrong lesson on a vehicle is costly.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { toolLoop, type ChatFn, type LoopResult, type ToolDef } from '../planning/llm.ts';
import { LESSON_FOLDERS, notePath, readNote, searchText } from './vault.ts';

export interface DebriefInput {
  mission: string;
  /** Run folder name, e.g. 2026-11-22T17-25-56-984Z */
  run: string;
  environment: 'sim' | 'real';
  /** spec.md of the mission */
  spec: string;
  /** events.jsonl of the run (and of earlier runs it continued, oldest first) */
  events: string;
  /** result.json */
  result: string;
  /** what actually happened, when known (the simulator's ground truth) */
  groundTruth?: string;
  /** the operator's remarks on the run */
  operatorNote?: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface DebriefOutput extends LoopResult {
  report: string | null;
  proposals: string[];
}

const frontmatter = (meta: Record<string, unknown>) => `---\n${toYaml(meta).trim()}\n---\n`;
const clean = (s: string) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() + '\n';
const safeName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim();

export async function runDebrief(dir: string, input: DebriefInput, chat: ChatFn, system: string, log?: (s: string) => void): Promise<DebriefOutput> {
  const reportPath = `Runs/${input.date} ${safeName(input.mission)} ${input.run.slice(11, 19)}`;
  const evidence = `[[${reportPath}]]`;
  let report: string | null = null;
  const proposals: string[] = [];
  const all = ['active', 'proposed', 'outdated'];

  const tools: ToolDef[] = [
    {
      name: 'vault_search',
      description: 'Search the experience vault, including proposed and outdated notes, so you extend existing notes instead of duplicating them.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: (a) => searchText(dir, String(a['query'] ?? ''), all),
    },
    {
      name: 'vault_read',
      description: 'Read one vault note in full (path as vault_search gives it). VAULT-INDEX has the map and the rules.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: (a) => readNote(dir, String(a['path'] ?? '')),
    },
    {
      name: 'write_run_report',
      description: `Write the run report (Markdown body, no frontmatter): what was planned, what happened, the outcome against the success criteria and the ground truth, and what went wrong with evidence (event times, step ids). Saved as ${evidence}. Call it once; a second call replaces it.`,
      parameters: {
        type: 'object',
        properties: {
          result: { type: 'string', description: 'one line, e.g. "0 of 3 balls delivered; completed, s1/s3/s5 failed"' },
          body: { type: 'string' },
        },
        required: ['result', 'body'],
      },
      run: (a) => {
        const meta = { status: 'proposed', type: 'run', environment: input.environment, mission: input.mission, run: input.run, date: input.date, result: String(a['result'] ?? '') };
        const file = notePath(dir, reportPath);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, frontmatter(meta) + `# ${input.mission}, ${input.date}\n\n` + clean(String(a['body'] ?? '')));
        report = reportPath;
        return `saved ${evidence}`;
      },
    },
    {
      name: 'propose_lesson',
      description: `Propose a lesson for later missions: one topic, written as facts and how to act on them, not as a diary. path is "<${LESSON_FOLDERS.join('|')}>/<topic>". A new topic becomes a new note; for an existing note give its FULL new text, saved beside it as a proposed edit for the operator to merge. The run report is linked as evidence automatically.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. "Behaviours/push_to - bare front"' },
          body: { type: 'string', description: 'Markdown, no frontmatter' },
          why: { type: 'string', description: 'one line: what in this run shows it' },
        },
        required: ['path', 'body', 'why'],
      },
      run: (a) => {
        const path = String(a['path'] ?? '').replace(/\.md$/, '').replace(/^\/+/, '');
        const folder = path.split('/')[0];
        if (!(LESSON_FOLDERS as readonly string[]).includes(folder ?? '') || path.split('/').length !== 2) {
          throw new Error(`path must be "<${LESSON_FOLDERS.join('|')}>/<topic>"`);
        }
        const meta: Record<string, unknown> = { status: 'proposed', type: 'lesson', environment: input.environment, evidence: [evidence], proposed: input.date, why: String(a['why'] ?? '') };
        let target = path;
        if (existsSync(notePath(dir, path))) {
          meta['edit_of'] = `[[${path}]]`;
          target = `Proposals/${safeName(path.replace('/', ' - '))} (${input.date})`;
        }
        const file = notePath(dir, target);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, frontmatter(meta) + `# ${path.split('/')[1]}\n\n` + clean(String(a['body'] ?? '')));
        proposals.push(target);
        return meta['edit_of'] ? `saved as a proposed edit of [[${path}]]: [[${target}]]` : `saved [[${target}]] (proposed)`;
      },
    },
    { name: 'done', description: 'Finish the debrief.', terminal: true, parameters: { type: 'object', properties: {} }, run: () => 'ok' },
  ];

  const user = [
    `Mission ${input.mission}, run ${input.run} (${input.environment === 'sim' ? 'in the simulator' : 'on the real rover'}), ${input.date}.`,
    input.operatorNote ? `\n## The operator's remarks\n${input.operatorNote}` : '',
    `\n## Result (result.json)\n${input.result}`,
    input.groundTruth ? `\n## Ground truth after the run (the simulator)\n${input.groundTruth}` : '',
    `\n## Events (events.jsonl; t is ms since epoch)\n${input.events}`,
    `\n## The mission spec the run executed (spec.md)\n${input.spec}`,
  ].join('\n');
  const r = await toolLoop(chat, system, user, tools, { maxSteps: 40, log });
  return { ...r, report, proposals };
}
