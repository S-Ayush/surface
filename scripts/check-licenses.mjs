// Fails when a production dependency has a licence outside the allowlist (ADR-0026).
// The policy lives in packages/config/licenses.js. pnpm reads the local store: no network.
import { execFileSync } from 'node:child_process';
import { findViolations } from '@surface/config/licenses';

const output = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const violations = findViolations(JSON.parse(output));

if (violations.length > 0) {
  console.error('licenses:check: production dependencies with a licence outside the allowlist:');
  for (const v of violations) console.error(`  ${v.name}@${v.versions.join(', ')}: ${v.license}`);
  console.error(
    'Replace the dependency, or record a named exception in packages/config/licenses.js with an ADR.',
  );
  process.exit(1);
}
console.log('licenses:check: all production dependency licences are allowed.');
