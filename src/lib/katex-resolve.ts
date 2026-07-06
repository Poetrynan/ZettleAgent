import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const generated = path.join(root, 'katex-inlined.css.ts');

/** Prefer build-generated CSS; fall back to committed stub for dev without build:prod. */
export const katexInlinedPath = fs.existsSync(generated) ? generated : path.join(root, 'katex-inlined.stub.ts');
