import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Knowledge = { text: string; files: string[] };

/** `<project>/knowledge/` — same relative depth from `src/classifier/` and `dist/classifier/`. */
export const defaultKnowledgeDir = fileURLToPath(new URL('../../knowledge/', import.meta.url));

const cache = new Map<string, Knowledge>();

/** Reads every `*.md` except `welcome.md`, sorted by filename, joined as `## <file>` blocks. */
export function loadKnowledge(dir: string = defaultKnowledgeDir): Knowledge {
  const hit = cache.get(dir);
  if (hit) return hit;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'welcome.md')
    .sort();
  const text = files
    .map((f) => `## ${f}\n\n${readFileSync(join(dir, f), 'utf8').trim()}`)
    .join('\n\n');
  const result = { text, files };
  cache.set(dir, result);
  return result;
}

export function resetKnowledgeCache(): void {
  cache.clear();
}
