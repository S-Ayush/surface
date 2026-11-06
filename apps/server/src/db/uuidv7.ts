import { randomFillSync } from 'node:crypto';

/**
 * A UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then random bits, so ids sort by creation
 * time (domain-model §1). Server-generated ids only; clients bring their own for synced rows.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomFillSync(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 9562 variant
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
