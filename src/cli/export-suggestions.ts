import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrap } from './bootstrap.js';
import { localDate, renderSuggestionsMarkdown } from './render.js';

const { dataDir, db, repos } = bootstrap();
const rows = repos.suggestions.list();
const date = localDate();
const dir = join(dataDir, 'exports');
mkdirSync(dir, { recursive: true });
const file = join(dir, `suggestions-${date}.md`);
writeFileSync(file, renderSuggestionsMarkdown(rows, date), 'utf8');
db.close();
console.log(`已匯出 ${rows.length} 筆 → ${file}`);
