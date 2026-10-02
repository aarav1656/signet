// The receipt hashing the MCP server uses (mcp/src/receipt.ts) is the single source; the page ships a byte copy
// because Vercel uploads web/ alone. Run: npm run sync:receipt. src/lib/receipt.test.ts fails if the copy drifts.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'mcp', 'src', 'receipt.ts'), 'utf8');
writeFileSync(join(here, '..', 'src', 'lib', 'receipt.ts'), src);
