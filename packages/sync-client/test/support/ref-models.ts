/**
 * Stand-ins for the PLAN-001 models that references resolve to, with the
 * columns the server resolvers read (`apps/server/src/executor/refs/sources.ts`).
 */
import { bool, defineModel, str, uuid } from '@surface/domain/model';

export const Team = defineModel('Team', {
  load: 'eager',
  fields: { key: str(), name: str(), private: bool() },
});

export const User = defineModel('User', {
  load: 'eager',
  fields: { email: str(), name: str(), displayName: str(), role: str(), active: bool() },
});

export const WorkflowStatus = defineModel('WorkflowStatus', {
  load: 'eager',
  fields: { teamId: uuid(), name: str(), category: str() },
});

export const Label = defineModel('Label', {
  load: 'eager',
  fields: { teamId: uuid().nullable(), parentId: uuid().nullable(), name: str(), isGroup: bool() },
});

export const REF_FIXTURE_MODELS = [Team, User, WorkflowStatus, Label] as const;
