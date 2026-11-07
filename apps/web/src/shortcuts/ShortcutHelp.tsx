// The `?` overlay (SPEC-005 §5, AC-8): every binding in this build, grouped and searchable.
import { useId, useState } from 'react';
import { Dialog, Input, Kbd, usePlatform } from '@surface/ui';
import { helpGroups } from './help.js';
import { SHORTCUTS, type Shortcut } from './registry.js';
import { useCommand } from './ShortcutProvider.js';
import styles from './ShortcutHelp.module.css';

export function ShortcutHelp({ bindings = SHORTCUTS }: { bindings?: readonly Shortcut[] }) {
  const [open, setOpen] = useState(false);
  useCommand('help:shortcuts', () => setOpen(true));
  return (
    <Dialog open={open} onOpenChange={setOpen} title="Keyboard shortcuts" size="lg">
      {open && <ShortcutHelpContent bindings={bindings} />}
    </Dialog>
  );
}

export function ShortcutHelpContent({
  bindings,
  initialQuery = '',
}: {
  bindings: readonly Shortcut[];
  initialQuery?: string;
}) {
  const platform = usePlatform();
  const [query, setQuery] = useState(initialQuery);
  const id = useId();
  const groups = helpGroups(bindings, { query, platform });
  return (
    <div className={styles.root}>
      <Input
        type="search"
        aria-label="Search shortcuts"
        placeholder="Search shortcuts"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {groups.map((group, i) => (
        <section key={group.group} aria-labelledby={`${id}-${i}`} className={styles.group}>
          <h3 id={`${id}-${i}`} className={styles.heading}>
            {group.group}
          </h3>
          <ul className={styles.rows}>
            {group.rows.map((row) => (
              <li key={row.id} className={styles.row}>
                <span>{row.title}</span>
                <Kbd keys={row.keys} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {/* Always mounted, so screen readers announce when a search finds nothing. */}
      <p role="status" className={styles.empty}>
        {groups.length === 0 ? `No shortcuts match "${query.trim()}"` : ''}
      </p>
    </div>
  );
}
