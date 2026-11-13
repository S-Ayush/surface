/**
 * What counts as one emoji (SPEC-013 §4.4 "Emoji", D22). The server uses this for `reaction.set` (S4) and
 * the editor's tests use it to check the bundled emoji data, so one definition serves both.
 * Pure regex, no DOM and no data. Built from a string because the `v` flag (RGI_Emoji matches
 * whole sequences: flags, skin tones, ZWJ families, keycaps) is newer than this package's
 * compile target.
 */
const SINGLE_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

/** True when `value` is exactly one RGI emoji (a sequence counts as one). */
export function isSingleEmoji(value: string): boolean {
  return value.length <= 64 && SINGLE_EMOJI.test(value);
}
