/**
 * Workspace operations (SPEC-001 §3.6, §6.2; PLAN-001 S7). Anyone reads the workspace's name;
 * only Admins change it (permissions.md §3.1).
 *
 * - The logo comes with file uploads (PLAN-001 S6, ADR-0014): `logoFileId` is read-only until
 *   then.
 * - `workspace.update` predicts nothing: the client store finds rows by id or reference, and the
 *   workspace has no reference type. Settings → Workspace waits for the server instead.
 */
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { Timestamp } from './shared.js';

export const WORKSPACE_NAME_MAX = 80;

const WorkspaceName = z
  .string()
  .trim()
  .min(1, 'Workspace name is required, like Acme')
  .max(WORKSPACE_NAME_MAX, `Workspace name must be ${WORKSPACE_NAME_MAX} characters or fewer`);

export const WorkspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  logoFileId: z.uuid().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const workspaceGet = defineOperation({
  name: 'workspace.get',
  kind: 'query',
  domain: 'workspace',
  summary: 'Get the workspace',
  description: 'Returns the workspace: its name, logo and when it was created.',
  keywords: ['workspace name', 'get workspace', 'workspace settings', 'what is this workspace'],
  input: z.object({}),
  output: WorkspaceSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{}],
});

export const workspaceUpdate = defineOperation({
  name: 'workspace.update',
  kind: 'mutation',
  domain: 'workspace',
  summary: 'Rename the workspace',
  description:
    'Changes the workspace’s name, shown in the sidebar, the browser tab and emails. Admins only.',
  keywords: ['rename workspace', 'change workspace name', 'workspace settings'],
  input: z.object({ name: WorkspaceName }),
  output: WorkspaceSchema,
  permission: (p) => p.admin(),
  destructive: false,
  examples: [{ name: 'Acme' }],
});
