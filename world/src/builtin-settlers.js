// The settlement program the world starts with. In development it is read from
// settlers/v1-naive.js; `npm run bundle` replaces this module with the inlined text,
// so the single-file bundle needs no settlers/ folder. The reference ledger is for
// tests only and is deliberately not available here.
import fs from 'node:fs';

export const V1_NAIVE_NAME = 'v1-naive.js';
export const V1_NAIVE_SOURCE = fs.readFileSync(new URL('../settlers/v1-naive.js', import.meta.url), 'utf8');
