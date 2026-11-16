// Package boundary rules (architecture.md §3). packages/config is build tooling and exempt.
//   domain ← operations ← (sync-client, apps/server)
//   apps/web → sync-client, ui, editor (and domain/operations)
//   sync-react → sync-client, ui (React bindings and the sync inspector, ADR-0017)
//   editor/src/schema is headless (@tiptap/core, @tiptap/pm, markdown-it, domain); the server
//   imports only that entry, `@surface/editor/schema` (SPEC-013 §4.4)
//   The server never imports UI or client packages; the client never imports server code.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'not-to-unresolvable',
      comment: 'Every import must resolve (catches imports of undeclared workspace packages).',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'declared-deps-only',
      comment: 'Source files may only import packages declared in their own package.json.',
      severity: 'error',
      from: { path: '/src/' },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-not-to-apps',
      // `packages/ui/.storybook/main.ts` lists `apps/web/src/**/*.stories.tsx` in its story glob
      // (PLAN-013 S5). A glob is tooling configuration, not an import, so the rule is unchanged.
      comment: 'Packages are libraries; they must never import from apps/.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'domain-is-a-leaf',
      comment: 'domain depends on no other workspace package.',
      severity: 'error',
      from: { path: '^packages/domain/' },
      to: { path: '^packages/(?!config/)', pathNot: '^packages/domain/' },
    },
    {
      name: 'operations-only-domain',
      severity: 'error',
      from: { path: '^packages/operations/' },
      to: { path: '^packages/(?!config/)', pathNot: '^packages/(operations|domain)/' },
    },
    {
      name: 'sync-protocol-only-domain',
      severity: 'error',
      from: { path: '^packages/sync-protocol/' },
      to: { path: '^packages/(?!config/)', pathNot: '^packages/(sync-protocol|domain)/' },
    },
    {
      name: 'sync-client-no-ui',
      comment: 'sync-client is headless: domain, operations and sync-protocol only.',
      severity: 'error',
      from: { path: '^packages/sync-client/' },
      to: {
        path: '^packages/(?!config/)',
        pathNot: '^packages/(sync-client|sync-protocol|operations|domain)/',
      },
    },
    {
      name: 'ui-and-editor-only-domain',
      severity: 'error',
      from: { path: '^packages/(ui|editor)/' },
      to: { path: '^packages/(?!config/)', pathNot: '^packages/(ui|editor|domain)/' },
    },
    {
      name: 'editor-schema-headless',
      comment:
        'The schema entry runs on the server: no DOM, React, lowlight or Node APIs. It may import only itself, domain, @tiptap/core, @tiptap/pm and markdown-it (SPEC-013 §4.4, AC-10).',
      severity: 'error',
      from: { path: '^packages/editor/src/schema/' },
      to: {
        pathNot: [
          '^packages/editor/src/schema/',
          '^packages/domain/',
          '(^|/)node_modules/(@tiptap/(core|pm)|markdown-it)/',
        ],
      },
    },
    {
      name: 'server-editor-schema-only',
      comment:
        'The server imports only the headless `@surface/editor/schema` entry, never the React editor (SPEC-013 §4.4).',
      severity: 'error',
      from: { path: '^apps/server/' },
      to: { path: '^packages/editor/', pathNot: '^packages/editor/src/schema/' },
    },
    {
      name: 'server-no-client-code',
      comment: 'The server never imports UI or client-store packages.',
      severity: 'error',
      from: { path: '^apps/server/' },
      to: { path: '^(packages/(ui|sync-client)|apps/web)/' },
    },
    {
      name: 'sync-react-deps',
      comment:
        'sync-react binds the sync store to React: sync-client, ui and domain only (ADR-0017).',
      severity: 'error',
      from: { path: '^packages/sync-react/' },
      to: {
        path: '^packages/(?!config/)',
        pathNot: '^packages/(sync-react|sync-client|ui|domain)/',
      },
    },
    {
      name: 'server-no-sync-react',
      comment: 'The server never imports the React bindings of the client store (ADR-0017).',
      severity: 'error',
      from: { path: '^apps/server/' },
      to: { path: '^packages/sync-react/' },
    },
    {
      name: 'web-no-server-code',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/server/' },
    },
    {
      name: 'bulk-only-from-repo',
      comment:
        "sync/bulk.ts builds the repo layer's bulk writes; only sync/repo.ts runs them, logging each row (CLAUDE.md rule 2, PLAN-011 S1).",
      severity: 'error',
      from: { path: '^apps/server/src/', pathNot: '^apps/server/src/sync/(repo|bulk)\\.ts$' },
      to: { path: '^apps/server/src/sync/bulk\\.ts$' },
    },
    {
      name: 'nothing-imports-tests',
      comment: 'tests/ holds cross-boundary test harnesses (ADR-0016); nothing may depend on them.',
      severity: 'error',
      from: { pathNot: '^tests/' },
      to: { path: '^tests/' },
    },
    {
      name: 'server-testing-only-in-tests',
      comment:
        "The real server for the sync simulation (`@surface/server/testing`) is for tests/ and the server's own tests only (PLAN-002 S9).",
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: '^apps/server/test/' },
      to: { path: '^apps/server/test/' },
    },
    {
      name: 'test-doubles-only-in-tests',
      comment:
        "sync-client's test doubles (`@surface/sync-client/testing`) are for its own tests and tests/ only (ADR-0016).",
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: '^packages/sync-client/' },
      to: { path: '^packages/sync-client/test/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage|\\.turbo)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['@surface/source', 'import', 'types', 'default'],
    },
  },
};
