// What counts as one emoji (SPEC-013 §4.4, D22) lives in `@surface/domain` since PLAN-013 S4's
// review, so `reaction.set`'s input schema can check it too. Re-exported here for the editor.
export { isSingleEmoji } from '@surface/domain';
