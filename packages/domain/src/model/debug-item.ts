/**
 * Engine fixture (PLAN-002 header): the sync engine is built and tested against
 * `DebugItem` until real models arrive in PLAN-001. Dev and test builds only:
 * it is not part of any production model list, so it never affects the
 * production schema hash.
 */
import { defineModel } from './define-model.js';
import { array, int, str } from './fields.js';

export const DebugItem = defineModel('DebugItem', {
  load: 'eager',
  fields: {
    title: str(),
    counter: int(),
    /** The row's sync groups, so tests can check group filtering end to end. */
    groups: array(str()),
  },
  indexes: ['title'],
});
