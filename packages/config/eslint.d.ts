import type { Linter } from 'eslint';

/** Synced tables the repo layer alone writes (SPEC-002 AC-12). */
export declare const SYNCED_TABLES: readonly { identifier: string; name: string }[];
export declare function surfaceEslint(options: { rootDir: string }): Linter.Config[];
