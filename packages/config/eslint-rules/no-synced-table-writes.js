/**
 * `surface/no-synced-table-writes` (SPEC-002 §4.2, AC-12): only the repo layer writes synced
 * tables, because it logs every change to `sync_log` in the same transaction. A write anywhere
 * else silently breaks sync. Files that may write (the repo itself) are left out with `ignores`.
 *
 * It flags:
 * - Drizzle `insert` / `update` / `delete` calls on a synced table: a listed export
 *   (`debugItems`, `schema.debugItems`), anything taken from `SYNCED_MODELS` (`.table`, also
 *   through a const alias or destructuring), or a const alias of either;
 * - raw SQL that inserts into, updates, deletes from, merges into or truncates one. The text is
 *   read from string literals, `+` concatenations, templates (a `${table}` expression counts as
 *   the table's name) and `sql.raw` / `sql.identifier` arguments.
 *
 * A table that reaches a write through a function parameter can't be seen statically: the
 * runtime write audit (`apps/server/test/executor.ts`) is the other half of AC-12.
 *
 * Options: `{ tables: [{ identifier: 'debugItems', name: 'debug_items' }, …] }`: the Drizzle
 * export and the SQL name of each table.
 */

/** Stands in for a synced table whose SQL name isn't known statically (`SYNCED_MODELS[m].table`). */
const SOME_TABLE = 'surface_synced_table';
const MAX_DEPTH = 8;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Write synced tables only through the repo layer' },
    schema: [
      {
        type: 'object',
        properties: {
          tables: {
            type: 'array',
            items: {
              type: 'object',
              properties: { identifier: { type: 'string' }, name: { type: 'string' } },
              required: ['identifier', 'name'],
              additionalProperties: false,
            },
          },
        },
        required: ['tables'],
        additionalProperties: false,
      },
    ],
    messages: {
      write:
        'Write {{table}} through the repo layer (apps/server/src/sync/repo.ts), so the change is logged to sync_log (SPEC-002 §4.2).',
    },
  },
  create(context) {
    /** @type {{ tables: { identifier: string, name: string }[] }} */
    const { tables } = context.options[0];
    const byIdentifier = new Map(tables.map((t) => [t.identifier, t.name]));
    const names = [...tables.map((t) => t.name), SOME_TABLE]
      .map((name) => name.replace(/[^a-z0-9_]/gi, ''))
      .join('|');
    // INSERT INTO, UPDATE [ONLY], DELETE FROM [ONLY], MERGE INTO [ONLY], TRUNCATE [TABLE] [ONLY],
    // optionally schema-qualified and quoted.
    const rawWrite = new RegExp(
      `\\b(?:insert\\s+into|update(?:\\s+only)?|delete\\s+from(?:\\s+only)?|merge\\s+into(?:\\s+only)?|truncate(?:\\s+table)?(?:\\s+only)?)\\s+(?:"?\\w+"?\\.)?"?(${names})"?(?![\\w"])`,
      'i',
    );
    /** Source ranges already reported, so a literal inside a reported template isn't reported again. */
    const reported = [];

    /**
     * What an expression is, as far as this rule cares: a synced table (with its SQL name), the
     * `SYNCED_MODELS` map or something taken from it, or neither (undefined).
     * @returns {{ kind: 'table', name: string } | { kind: 'models' } | undefined}
     */
    function resolve(node, depth = 0) {
      if (!node || depth > MAX_DEPTH) return undefined;
      switch (node.type) {
        case 'Identifier': {
          if (node.name === 'SYNCED_MODELS') return { kind: 'models' };
          const name = byIdentifier.get(node.name);
          if (name) return { kind: 'table', name };
          return resolveVariable(node, depth);
        }
        case 'MemberExpression': {
          const key = propertyName(node);
          const name = key === undefined ? undefined : byIdentifier.get(key);
          if (name) return { kind: 'table', name };
          if (key === 'SYNCED_MODELS') return { kind: 'models' };
          return member(resolve(node.object, depth + 1), key);
        }
        case 'ChainExpression':
        case 'TSNonNullExpression':
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
          return resolve(node.expression, depth + 1);
        default:
          return undefined;
      }
    }

    /** `value[key]`: a model's `table` is a synced table; anything else under the map is too. */
    function member(value, key) {
      if (value?.kind !== 'models') return undefined;
      return key === 'table' ? { kind: 'table', name: SOME_TABLE } : value;
    }

    /** Follows an identifier to its declaration: an import, or a `const` (maybe destructured). */
    function resolveVariable(identifier, depth) {
      const variable = findVariable(identifier);
      const def = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      if (!def) return undefined;
      if (def.type === 'ImportBinding' && def.node.type === 'ImportSpecifier') {
        const imported = def.node.imported.name ?? def.node.imported.value;
        if (imported === 'SYNCED_MODELS') return { kind: 'models' };
        const name = byIdentifier.get(imported);
        return name ? { kind: 'table', name } : undefined;
      }
      if (def.type !== 'Variable' || def.parent.kind !== 'const' || !def.node.init)
        return undefined;
      const init = resolve(def.node.init, depth + 1);
      if (def.node.id === def.name) return init;
      // `const { table } = SYNCED_MODELS.Issue` or `const { table: t } = …`: one level deep.
      if (def.node.id.type !== 'ObjectPattern') return undefined;
      const property = def.node.id.properties.find(
        (p) =>
          p.type === 'Property' &&
          (p.value === def.name ||
            (p.value.type === 'AssignmentPattern' && p.value.left === def.name)),
      );
      return property ? member(init, propertyName(property)) : undefined;
    }

    function findVariable(identifier) {
      for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
      }
      return undefined;
    }

    /** The static key of `a.b`, `a['b']` or `{ b: … }`; undefined when computed from a value. */
    function propertyName(node) {
      const key = node.type === 'Property' ? node.key : node.property;
      if (!node.computed && key.type === 'Identifier') return key.name;
      if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
      return undefined;
    }

    /** The SQL text an expression builds, with `?` for parts that aren't known statically. */
    function textOf(node, depth = 0) {
      if (depth > MAX_DEPTH) return ' ? ';
      switch (node.type) {
        case 'Literal':
          return typeof node.value === 'string' ? node.value : ' ? ';
        case 'TemplateLiteral':
          return node.quasis
            .map((q, i) => {
              const expression = node.expressions[i];
              const text = q.value.cooked ?? q.value.raw;
              return expression ? text + textOf(expression, depth + 1) : text;
            })
            .join('');
        case 'TaggedTemplateExpression':
          return textOf(node.quasi, depth + 1);
        case 'BinaryExpression':
          return node.operator === '+'
            ? textOf(node.left, depth + 1) + textOf(node.right, depth + 1)
            : ' ? ';
        case 'CallExpression': {
          // sql.raw('…') and sql.identifier('…') put their argument into the SQL as written.
          const callee = node.callee;
          const name = callee.type === 'MemberExpression' ? propertyName(callee) : undefined;
          if ((name === 'raw' || name === 'identifier') && node.arguments.length === 1) {
            return textOf(node.arguments[0], depth + 1);
          }
          return ' ? ';
        }
        default: {
          const value = resolve(node);
          return value?.kind === 'table' ? value.name : ' ? ';
        }
      }
    }

    function report(node, table) {
      reported.push(node.range);
      context.report({
        node,
        messageId: 'write',
        data: { table: table === SOME_TABLE ? 'a synced table' : table },
      });
    }

    function checkText(node) {
      const [start, end] = node.range;
      if (reported.some(([s, e]) => s <= start && end <= e)) return;
      const match = rawWrite.exec(textOf(node));
      if (match?.[1]) report(node, match[1]);
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (!['insert', 'update', 'delete'].includes(propertyName(callee) ?? '')) return;
        const value = resolve(node.arguments[0]);
        if (value?.kind === 'table') report(node, value.name);
      },
      // Visited outside in, so the outermost text that writes is the one reported.
      TemplateLiteral: checkText,
      BinaryExpression(node) {
        if (node.operator === '+') checkText(node);
      },
      Literal(node) {
        if (typeof node.value === 'string') checkText(node);
      },
    };
  },
};
