/**
 * `surface/no-synced-table-writes` (SPEC-002 §4.2, AC-12): only the repo layer writes synced
 * tables, because it logs every change to `sync_log` in the same transaction. A write anywhere
 * else silently breaks sync. Flags Drizzle `insert` / `update` / `delete` calls on a listed
 * table, and raw SQL (`sql` templates or strings) that inserts into, updates, deletes from or
 * truncates one. Files that may write (the repo itself) are left out with `ignores`.
 *
 * Options: `{ tables: [{ identifier: 'debugItems', name: 'debug_items' }, …] }`: the Drizzle
 * export and the SQL name of each table.
 */

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
    const names = tables.map((t) => t.name.replace(/[^a-z0-9_]/gi, '')).join('|');
    // INSERT INTO, UPDATE [ONLY], DELETE FROM [ONLY], TRUNCATE [TABLE] [ONLY], optionally
    // schema-qualified and quoted.
    const rawWrite = new RegExp(
      `\\b(?:insert\\s+into|update(?:\\s+only)?|delete\\s+from(?:\\s+only)?|truncate(?:\\s+table)?(?:\\s+only)?)\\s+(?:"?\\w+"?\\.)?"?(${names})"?(?![\\w"])`,
      'i',
    );

    /** The table name a Drizzle table argument refers to: `debugItems` or `schema.debugItems`. */
    function tableOf(node) {
      if (node?.type === 'Identifier') return byIdentifier.get(node.name);
      if (node?.type === 'MemberExpression' && node.property.type === 'Identifier') {
        return byIdentifier.get(node.property.name);
      }
      return undefined;
    }

    function checkText(node, text) {
      const match = rawWrite.exec(text);
      if (match) context.report({ node, messageId: 'write', data: { table: match[1] } });
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return;
        if (!['insert', 'update', 'delete'].includes(callee.property.name)) return;
        const table = tableOf(node.arguments[0]);
        if (table) context.report({ node, messageId: 'write', data: { table } });
      },
      TemplateLiteral(node) {
        checkText(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' ? '));
      },
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value);
      },
    };
  },
};
