// Structured result recorder. Every experiment writes exactly one record with
// the fields the architecture requires. Records are append-only: a re-run writes
// a new revision rather than overwriting, so a failure can never be edited away.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'results');

export const STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  CONDITIONAL: 'CONDITIONAL PASS',
  BLOCKED: 'BLOCKED',
};

const REQUIRED = [
  'id',
  'status',
  'question',
  'environment',
  'programs',
  'procedure',
  'signatures',
  'txSizeBytes',
  'accountCount',
  'computeUnits',
  'costLamports',
  'observed',
  'expected',
  'discrepancy',
  'decision',
];

export function record(result) {
  const missing = REQUIRED.filter((k) => !(k in result));
  if (missing.length) {
    throw new Error(`result is missing required fields: ${missing.join(', ')}`);
  }
  if (!Object.values(STATUS).includes(result.status)) {
    throw new Error(`invalid status: ${result.status}`);
  }

  mkdirSync(RESULTS, { recursive: true });
  const path = join(RESULTS, `${result.id}.json`);

  const history = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  history.push({ ...result, recordedAt: new Date().toISOString() });
  writeFileSync(path, JSON.stringify(history, null, 2));

  console.log(`\n=== ${result.id} — ${result.status} ===`);
  console.log(`Q: ${result.question}`);
  console.log(`Observed: ${result.observed}`);
  console.log(`Decision: ${result.decision}`);
  console.log(`(revision ${history.length} written to results/${result.id}.json)`);
  return path;
}

export function latest(id) {
  const path = join(RESULTS, `${id}.json`);
  if (!existsSync(path)) return null;
  const history = JSON.parse(readFileSync(path, 'utf8'));
  return history[history.length - 1] ?? null;
}

// An experiment may not run if the one it depends on has not passed.
// This is what stops a failure being silently worked around.
export function requirePassed(ids) {
  for (const id of ids) {
    const r = latest(id);
    if (!r) throw new Error(`${id} has not been run. Run it first.`);
    if (r.status === STATUS.FAIL || r.status === STATUS.BLOCKED) {
      throw new Error(
        `${id} is ${r.status}. Apply the decision matrix before continuing; do not work around it.`,
      );
    }
  }
}
