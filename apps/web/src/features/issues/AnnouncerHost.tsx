// Renders the issue announcer's polite live region (SPEC-012 §7.4). Mounted once in the shell.
import { VisuallyHidden } from '@surface/ui';
import { useSyncExternalStore } from 'react';
import { announcer } from './announcer.js';

export function AnnouncerHost() {
  const { text, serial } = useSyncExternalStore(
    announcer.subscribe,
    announcer.snapshot,
    announcer.snapshot,
  );
  return (
    <VisuallyHidden>
      <p role="status" aria-live="polite" data-serial={serial}>
        {text}
      </p>
    </VisuallyHidden>
  );
}
