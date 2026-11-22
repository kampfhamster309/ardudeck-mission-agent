// The experience vault: an Obsidian-compatible git folder of Markdown notes with what earlier
// missions taught (see the vault's VAULT-INDEX.md). The planner and validator read it; the
// post-run debrief proposes new notes and edits, which the operator accepts in Obsidian
// (status: proposed -> active). Agents never mark a lesson active themselves.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface Note {
  /** Path inside the vault, without ".md", e.g. "Behaviours/goto - arrival" */
  path: string;
  title: string;
  meta: Record<string, unknown>;
  body: string;
}

export const LESSON_FOLDERS = ['Rover', 'Behaviours', 'Sites', 'Strategy'] as const;

/** The vault folder: MISSION_VAULT, else ~/vaults/jetrover; null when off or missing. */
export function vaultDir(env = process.env): string | null {
  const v = env['MISSION_VAULT'];
  if (v === 'off' || v === '') return null;
  const dir = resolve(v ?? join(homedir(), 'vaults', 'jetrover'));
  return existsSync(join(dir, 'VAULT-INDEX.md')) ? dir : null;
}

export function parseNote(path: string, text: string): Note {
  let meta: Record<string, unknown> = {};
  let body = text;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    try { meta = (parseYaml(m[1]!) as Record<string, unknown>) ?? {}; } catch { meta = {}; }
    body = text.slice(m[0].length);
  }
  return { path, title: path.split('/').at(-1)!, meta, body };
}

export function listNotes(dir: string): Note[] {
  const out: Note[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) {
        const rel = relative(dir, full).split(sep).join('/').replace(/\.md$/, '');
        out.push(parseNote(rel, readFileSync(full, 'utf-8')));
      }
    }
  };
  walk(dir);
  return out;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9_äöüß]+/).filter((w) => w.length > 2);

/**
 * Notes matching the query, best first: each query word counts 3x in the title, 1x per line of
 * the body that has it. Only the given statuses (default: accepted lessons and run reports).
 */
export function searchVault(dir: string, query: string, opts: { statuses?: string[]; limit?: number } = {}) {
  const statuses = opts.statuses ?? ['active'];
  const q = [...new Set(words(query))];
  if (!q.length) return [];
  const hits: Array<{ note: Note; score: number; lines: string[] }> = [];
  for (const note of listNotes(dir)) {
    if (note.path === 'VAULT-INDEX') continue;
    if (!statuses.includes(String(note.meta['status'] ?? 'active'))) continue;
    const title = note.path.toLowerCase();
    let score = 0;
    const lines: string[] = [];
    for (const w of q) if (title.includes(w)) score += 3;
    for (const line of note.body.split('\n')) {
      const l = line.toLowerCase();
      const n = q.filter((w) => l.includes(w)).length;
      if (n) { score += n; if (lines.length < 3 && line.trim() && !/^#+ /.test(line)) lines.push(line.trim().slice(0, 200)); }
    }
    if (score) hits.push({ note, score, lines });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
}

/** Resolve a note path inside the vault; refuses anything outside it. */
export function notePath(dir: string, path: string): string {
  const rel = path.replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '').replace(/\.md$/, '');
  const full = resolve(dir, `${rel}.md`);
  if (!full.startsWith(resolve(dir) + sep)) throw new Error(`"${path}" is outside the vault`);
  return full;
}

export function readNote(dir: string, path: string): string {
  const full = notePath(dir, path);
  if (!existsSync(full)) throw new Error(`no note "${path}" (use vault_search to find notes)`);
  return readFileSync(full, 'utf-8');
}

/** Search result as text for an agent. */
export function searchText(dir: string, query: string, statuses?: string[]): string {
  const hits = searchVault(dir, query, { statuses });
  if (!hits.length) return `No ${statuses ? statuses.join('/') : 'accepted'} notes match "${query}".`;
  return hits.map((h) => {
    const m = h.note.meta;
    const tags = [m['type'], m['status'], m['environment'] ? `environment: ${m['environment']}` : ''].filter(Boolean).join(', ');
    return `[[${h.note.path}]] (${tags})\n${h.lines.map((l) => `  ${l}`).join('\n')}`;
  }).join('\n\n');
}
