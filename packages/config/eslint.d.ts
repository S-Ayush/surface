import type { Linter } from 'eslint';

/** Synced tables the repo layer alone writes (SPEC-002 AC-12). */
export declare const SYNCED_TABLES: readonly { identifier: string; name: string }[];
/** The `no-restricted-imports` options that ban the CDN-capable emoji libraries (SPEC-013 AC-16). */
export declare const EMOJI_LIBRARY_BAN: {
  readonly paths: readonly { readonly name: string; readonly message: string }[];
  readonly patterns: readonly { readonly group: readonly string[]; readonly message: string }[];
};
export declare function surfaceEslint(options: { rootDir: string }): Linter.Config[];
