import { useEffect, type ReactNode } from 'react';
import { ToastProvider, ToastRegion } from '../components/Toast/Toast.js';
import { TooltipProvider } from '../components/Tooltip/Tooltip.js';
import { overlayManager } from './manager.js';

/**
 * Mount once at the app root (PLAN-005 S3): tooltip timing, and the toasts of `overlayManager`.
 * Modals, popovers and menus need nothing here; they register their layers as they open. Place
 * <BannerRegion> where the layout wants banners.
 */
export function OverlayProvider({ children }: { children: ReactNode }) {
  // Window capture runs before Radix's document listener, while the overlay is still registered
  // (see overlayManager.isOverlayEscape).
  useEffect(() => {
    const note = (event: KeyboardEvent) => overlayManager.noteKeydown(event);
    window.addEventListener('keydown', note, { capture: true });
    return () => window.removeEventListener('keydown', note, { capture: true });
  }, []);
  return (
    <TooltipProvider>
      <ToastProvider>
        {children}
        <ToastRegion />
      </ToastProvider>
    </TooltipProvider>
  );
}
