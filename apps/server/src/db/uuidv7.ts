import { randomFillSync } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, a 12-bit counter, then random bits. Ids sort by
 * creation time (domain-model §1), and ids made in the same millisecond by this process keep
 * their order, because the counter increments (RFC 9562 §6.2, method 1). Outbox events of one
 * transaction share a millisecond, so `ORDER BY id` is emit order.
 * Server-generated ids only; clients bring their own for synced rows.
 */
let lastMs = -1;
let counter = 0;

const COUNTER_MAX = 0xfff;

export function uuidv7(): string {
  const now = Date.now();
  const bytes = randomFillSync(new Uint8Array(16));
  if (now > lastMs) {
    lastMs = now;
    // Start low in the range, leaving room to count up within the millisecond.
    counter = (bytes[6] ?? 0) & 0x1ff;
  } else if (counter < COUNTER_MAX) {
    // Same millisecond, or the clock went back: keep counting from the last id.
    counter++;
  } else {
    // Counter exhausted: borrow the next millisecond (stays monotonic).
    lastMs++;
    counter = 0;
  }
  let ms = lastMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | (counter >> 8); // version 7 + counter high bits
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 9562 variant
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
