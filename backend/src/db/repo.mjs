// Repository dispatcher. Production uses the Postgres driver; the integration
// test uses the in-memory driver (no Postgres required). Both implement the
// same method surface and the same conflict semantics.

import { config } from '../config.mjs';

const mod = await import(config.dbDriver === 'memory' ? './repo.memory.mjs' : './repo.pg.mjs');
export const repo = mod.repo;
