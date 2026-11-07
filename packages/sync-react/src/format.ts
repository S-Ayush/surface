/** Sizes and durations for the inspector, in short English units. */

const BYTE_UNITS = ['KB', 'MB', 'GB'] as const;

/** `512 B`, `4.0 KB`, `1.2 MB` (powers of 1024). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  let value = bytes / 1024;
  let unit: (typeof BYTE_UNITS)[number] = 'KB';
  for (const next of BYTE_UNITS.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** `120 ms`, `12 s`, `3 min`, `2 h`: precise enough for ages and lag. */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 1000) return `${Math.round(clamped)} ms`;
  if (clamped < 60_000) return `${Math.floor(clamped / 1000)} s`;
  if (clamped < 3_600_000) return `${Math.floor(clamped / 60_000)} min`;
  return `${Math.floor(clamped / 3_600_000)} h`;
}
