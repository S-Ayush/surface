// How Settings → Security names a session (SPEC-001 §3.5: device, IP, last active). The server
// keeps the browser's User-Agent; a rough "Firefox on macOS" is enough to recognise your own.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdgA?\//, 'Edge'],
  [/\bOPR\//, 'Opera'],
  [/\bFirefox\//, 'Firefox'],
  [/\bChrom(e|ium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+ (Mobile\/\w+ )?Safari\//, 'Safari'],
  [/^curl\//, 'curl'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\b(Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
];

const first = (patterns: readonly (readonly [RegExp, string])[], text: string) =>
  patterns.find(([pattern]) => pattern.test(text))?.[1];

export function deviceName(userAgent: string | null): string {
  if (userAgent === null || userAgent.trim() === '') return 'Unknown device';
  const browser = first(BROWSERS, userAgent);
  const system = first(SYSTEMS, userAgent);
  if (browser !== undefined && system !== undefined) return `${browser} on ${system}`;
  if (browser !== undefined) return browser;
  if (system !== undefined) return `A browser on ${system}`;
  return 'Unknown device';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Active now", "Active 5 minutes ago", …, then the date. */
export function lastActiveText(lastUsedAt: string, now: Date): string {
  const at = new Date(lastUsedAt);
  const ago = now.getTime() - at.getTime();
  if (ago < 2 * MINUTE) return 'Active now';
  const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (ago < HOUR) return `Active ${relative.format(-Math.floor(ago / MINUTE), 'minute')}`;
  if (ago < DAY) return `Active ${relative.format(-Math.floor(ago / HOUR), 'hour')}`;
  if (ago < 7 * DAY) return `Active ${relative.format(-Math.floor(ago / DAY), 'day')}`;
  const date = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' });
  return `Active on ${date.format(at)}`;
}
