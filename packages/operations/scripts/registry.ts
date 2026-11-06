/**
 * `pnpm registry:lint` prints every SPEC-003 §11 problem in the registry and exits 1 if there
 * are any. `pnpm registry:snapshot` records the public catalog as released (run it on release),
 * which rule 8 then diffs against.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ALL_OPERATIONS } from '../src/index.js';
import { LINT_RULES, catalogSnapshot, lintOperations, parseSnapshot } from '../src/lint.js';

const SNAPSHOT_PATH = new URL('../catalog.snapshot.json', import.meta.url);

const command = process.argv[2];
if (command === 'lint') {
  const snapshot = parseSnapshot(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')));
  const problems = lintOperations(ALL_OPERATIONS, { snapshot });
  for (const p of problems) {
    process.stderr.write(`${p.operation}: rule ${p.rule} (${LINT_RULES[p.rule]}): ${p.message}\n`);
  }
  const summary =
    problems.length === 0
      ? `registry lint: ${ALL_OPERATIONS.length} operations, no problems\n`
      : `registry lint: ${problems.length} problem(s). Fix them, or see SPEC-003 §11\n`;
  process.stdout.write(summary);
  process.exitCode = problems.length === 0 ? 0 : 1;
} else if (command === 'snapshot') {
  const snapshot = catalogSnapshot(ALL_OPERATIONS);
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  const count = Object.keys(snapshot.operations).length;
  process.stdout.write(`catalog.snapshot.json: ${count} public operation(s) recorded\n`);
} else {
  process.stderr.write('Usage: registry.ts lint | snapshot\n');
  process.exitCode = 2;
}
