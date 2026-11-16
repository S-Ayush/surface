/**
 * What counts as one emoji (SPEC-013 §4.4 "Emoji", D22). `reaction.set` checks it on both sides:
 * the operation's input schema (so the client never predicts a row the server refuses) and the
 * server's handler; the editor uses it to filter the bundled emoji data. One definition serves all.
 * Pure regex, no DOM and no data. Built from a string because the `v` flag (RGI_Emoji matches
 * whole sequences: flags, skin tones, ZWJ families, keycaps) is newer than the compile target.
 */
const SINGLE_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

/** True when `value` is exactly one RGI emoji (a sequence counts as one). */
export function isSingleEmoji(value: string): boolean {
  return value.length <= 64 && SINGLE_EMOJI.test(value);
}
