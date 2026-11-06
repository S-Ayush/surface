// Platform-aware key labels (design-system §5.1 Kbd, shortcuts.md rule 1): `Mod` is ⌘ on macOS and
// Ctrl elsewhere. Detection runs once; stories and tests pin it with <PlatformProvider>.
import { createContext, use, type ReactNode } from 'react';

export type Platform = 'mac' | 'other';

type NavigatorWithUAData = Navigator & { userAgentData?: { platform?: string } };

/** Best-effort OS detection. Outside a browser (tests, SSR) it returns 'other'. */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const nav: NavigatorWithUAData = navigator;
  const name = nav.userAgentData?.platform ?? nav.platform;
  return /mac|iphone|ipad|ipod/i.test(name) ? 'mac' : 'other';
}

const PlatformContext = createContext<Platform | null>(null);

let detected: Platform | null = null;

export function usePlatform(): Platform {
  const pinned = use(PlatformContext);
  if (pinned) return pinned;
  detected ??= detectPlatform();
  return detected;
}

export function PlatformProvider({
  platform,
  children,
}: {
  platform: Platform;
  children: ReactNode;
}) {
  return <PlatformContext value={platform}>{children}</PlatformContext>;
}
