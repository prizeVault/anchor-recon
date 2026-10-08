import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// dist/src/paths.js -> project root is three levels up (app/dist/src).
const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, '..', '..', '..');
export const SEED_DIR = process.env.RECON_CONFIG_DIR ?? join(PROJECT_ROOT, 'data', 'seed');
export const VECTORS_DIR = join(PROJECT_ROOT, 'app', 'test', 'vectors');
