// Export the genre ontology (single source of truth: src/core/ontology.js)
// to JSON for the Python backend.   node scripts/export-ontology.mjs
import fs from 'node:fs';
import { GENRES } from '../src/core/ontology.js';
const out = new URL('../refscope/data/genres.json', import.meta.url);
fs.writeFileSync(out, JSON.stringify(GENRES, null, 1) + '\n');
console.log(`wrote ${GENRES.length} genres → ${out.pathname}`);
