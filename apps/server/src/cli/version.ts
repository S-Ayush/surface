/**
 * `surface version`: what is running, without needing configuration or a database.
 *
 * "Schema" is the newest migration this build ships. The sync `schemaHash`
 * (sync-protocol.md §7) is added here once the synced model exists (PLAN-002).
 */
import { buildInfo, type BuildInfo } from '../build-info.js';
import { loadMigrations, type Migration } from '../db/migrate.js';
import { EXIT, type CliIo } from './io.js';

export interface VersionReport {
  version: string;
  commit: string;
  /** Tag of the newest migration in this build, or null if there are none. */
  schema: string | null;
  migrations: number;
  node: string;
}

export function versionReport(
  info: BuildInfo = buildInfo(),
  migrations: Migration[] = loadMigrations(),
): VersionReport {
  return {
    version: info.version,
    commit: info.commit,
    schema: migrations.at(-1)?.tag ?? null,
    migrations: migrations.length,
    node: process.version,
  };
}

export function formatVersion(report: VersionReport): string {
  const plural = report.migrations === 1 ? 'migration' : 'migrations';
  return [
    `Surface ${report.version}`,
    `commit  ${report.commit}`,
    `schema  ${report.schema ?? 'none'} (${report.migrations} ${plural})`,
    `node    ${report.node}`,
    '',
  ].join('\n');
}

export function versionCommand(io: CliIo, { json }: { json: boolean }): number {
  const report = versionReport();
  io.out(json ? `${JSON.stringify(report)}\n` : formatVersion(report));
  return EXIT.ok;
}
