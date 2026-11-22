// Prompt files: prompts/ by default, or another folder (MISSION_PROMPTS), e.g. prompts-neutral/
// for runs without hints about the expected solution.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadPrompt(name: string): string {
  const dir = process.env['MISSION_PROMPTS'];
  return dir
    ? readFileSync(resolve(dir, `${name}.md`), 'utf-8')
    : readFileSync(new URL(`../../prompts/${name}.md`, import.meta.url), 'utf-8');
}
