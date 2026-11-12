// PLAN-013 S1: the editor boundary rules (SPEC-013 §4.4, AC-10) hold on the real tree and catch
// a violation of each.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IConfiguration, ICruiseResult, IForbiddenRuleType } from 'dependency-cruiser';
import { cruise } from 'dependency-cruiser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RULES = ['editor-schema-headless', 'server-editor-schema-only'];

function loadConfig(): IConfiguration {
  const config: unknown = createRequire(import.meta.url)(join(ROOT, '.dependency-cruiser.cjs'));
  if (typeof config !== 'object' || config === null || !('forbidden' in config)) {
    throw new Error('.dependency-cruiser.cjs has no forbidden rules');
  }
  return config as IConfiguration;
}

const config = loadConfig();
const editorRules: IForbiddenRuleType[] = (config.forbidden ?? []).filter((rule) =>
  RULES.includes(rule.name ?? ''),
);

async function violations(baseDir: string, paths: string[]): Promise<string[]> {
  const result = await cruise(paths, {
    baseDir,
    validate: true,
    ruleSet: { forbidden: editorRules },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    enhancedResolveOptions: config.options?.enhancedResolveOptions,
    outputType: 'json',
  });
  const output: unknown =
    typeof result.output === 'string' ? JSON.parse(result.output) : result.output;
  const summary = (output as ICruiseResult).summary;
  return summary.violations.map((v) => `${v.rule.name}: ${v.from} → ${v.to}`);
}

describe('editor boundary rules', () => {
  it('are both defined in .dependency-cruiser.cjs', () => {
    expect(editorRules.map((rule) => rule.name).sort()).toEqual([...RULES].sort());
  });

  it('pass on the real tree', async () => {
    expect(await violations(ROOT, ['packages/editor/src', 'apps/server/src'])).toEqual([]);
  }, 60_000);

  describe('on a tree that breaks them', () => {
    let dir = '';
    const file = async (path: string, text: string) => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    };

    beforeAll(async () => {
      // realpath: macOS's tmpdir is a symlink, and the rules match paths relative to baseDir.
      dir = await realpath(await mkdtemp(join(tmpdir(), 'surface-editor-boundaries-')));
      await file('packages/editor/src/index.ts', 'export const editor = 1;\n');
      await file('packages/editor/src/schema/ok.ts', 'export const ok = 1;\n');
      await file(
        'packages/editor/src/schema/bad.ts',
        "import { readFileSync } from 'node:fs';\nimport { editor } from '../index.js';\nimport { ok } from './ok.js';\nexport const bad = [readFileSync, editor, ok];\n",
      );
      await file(
        'apps/server/src/uses-editor.ts',
        "import { editor } from '../../../packages/editor/src/index.js';\nimport { ok } from '../../../packages/editor/src/schema/ok.js';\nexport const both = [editor, ok];\n",
      );
    });

    afterAll(async () => {
      if (dir !== '') await rm(dir, { recursive: true, force: true });
    });

    it('report a Node API and the React entry in the schema folder, and the server reaching past the schema entry', async () => {
      expect((await violations(dir, ['packages', 'apps'])).sort()).toEqual([
        'editor-schema-headless: packages/editor/src/schema/bad.ts → fs',
        'editor-schema-headless: packages/editor/src/schema/bad.ts → packages/editor/src/index.ts',
        'server-editor-schema-only: apps/server/src/uses-editor.ts → packages/editor/src/index.ts',
      ]);
    }, 60_000);
  });
});
