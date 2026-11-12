/**
 * Engine fixture (PLAN-002 header): the sync engine is built and tested against
 * `DebugItem` until real models arrive in PLAN-001. Dev and test builds only:
 * it is not part of any production model list, so it never affects the
 * production schema hash.
 */
import { defineModel } from './define-model.js';
import { array, int, str, timestamp } from './fields.js';

export const DebugItem = defineModel('DebugItem', {
  load: 'eager',
  fields: {
    title: str(),
    counter: int(),
    /** The row's sync groups, so tests can check group filtering end to end. */
    groups: array(str()),
    /** Archive state on the wire (protocol v0.7, SPEC-011 §5.5), for the sync property suite. */
    archivedAt: timestamp().nullable(),
  },
  indexes: ['title'],
});
