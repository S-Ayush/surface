/**
 * The sync inspector (SPEC-002 §5.4): connection, position, lag, queue,
 * recent packets, rejections, rows per model, storage, and "Force resync".
 * The app decides where it is mounted and whether (`inspectorAllowed`).
 */
import type { InspectorSnapshot, PacketView } from '@surface/sync-client';
import { storageUsage } from '@surface/sync-client';
import { Badge, Button } from '@surface/ui';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useSyncStore } from './context.js';
import { formatBytes, formatDuration } from './format.js';
import { useInspector } from './hooks.js';
import styles from './SyncInspector.module.css';

/** How often ages tick and the storage size is read again. */
const TICK_MS = 1000;
const USAGE_MS = 10_000;

const ACTIONS: Record<PacketView['action'], string> = {
  I: 'insert',
  U: 'update',
  A: 'archive',
  V: 'unarchive',
  D: 'delete',
};

export interface SyncInspectorProps {
  readonly className?: string;
}

/** The panel, reading the store from `SyncStoreProvider`. */
export function SyncInspector({ className }: SyncInspectorProps) {
  const store = useSyncStore();
  const snapshot = useInspector();
  const now = useNow();
  const usage = useStorageUsage();
  const [resyncing, setResyncing] = useState(false);
  const forceResync = () => {
    setResyncing(true);
    // A failure shows as the status and error above; the store retries on its own.
    store
      .resync()
      .catch(() => undefined)
      .finally(() => setResyncing(false));
  };
  return (
    <InspectorView
      snapshot={snapshot}
      now={now}
      usage={usage}
      resyncing={resyncing}
      onResync={forceResync}
      {...(className === undefined ? {} : { className })}
    />
  );
}

export interface InspectorViewProps {
  readonly snapshot: InspectorSnapshot;
  /** Epoch ms, for ages. */
  readonly now: number;
  /** Bytes the origin stores, if known. */
  readonly usage: number | undefined;
  readonly resyncing: boolean;
  readonly onResync: () => void;
  readonly className?: string;
}

/** The panel's markup, from plain data. */
export function InspectorView({
  snapshot: s,
  now,
  usage,
  resyncing,
  onResync,
  className,
}: InspectorViewProps) {
  const age = (epochMs: number) => formatDuration(now - epochMs);
  return (
    <section
      className={className === undefined ? styles.root : `${styles.root} ${className}`}
      aria-label="Sync inspector"
    >
      <header className={styles.header}>
        <h2 className={styles.title}>Sync inspector</h2>
        <Button size="sm" loading={resyncing} onClick={onResync}>
          Force resync
        </Button>
      </header>

      <dl className={styles.facts}>
        <Fact label="Status">
          {s.status}
          {s.error === undefined ? null : <span className={styles.error}> · {s.error}</span>}
        </Fact>
        <Fact label="Connection">
          {s.connection.state} for {age(s.connection.since)}
          {s.connection.reconnectingSince === undefined
            ? null
            : ` · reconnecting for ${age(s.connection.reconnectingSince)}`}
          {s.connection.liveUpdatesUnavailable ? (
            <span className={styles.error}> · live updates look blocked by a proxy</span>
          ) : null}
        </Fact>
        <Fact label="lastSyncId">
          <code>{s.lastSyncId ?? 'none'}</code>
        </Fact>
        <Fact label="Client">
          <code>{s.clientId}</code>
        </Fact>
        <Fact label="Server lag">
          {s.roundTrip === undefined
            ? 'No change confirmed yet'
            : `${formatDuration(s.roundTrip.ms)} (${s.roundTrip.op} #${s.roundTrip.seq})`}
        </Fact>
        <Fact label="Storage">
          {s.status === 'idle' ? 'Not open' : s.persistent ? 'IndexedDB' : 'Memory only'}
          {usage === undefined ? null : ` · ${formatBytes(usage)} used by this site`}
          {s.storageWarning === undefined ? null : (
            <span className={styles.error}> · {s.storageWarning}</span>
          )}
        </Fact>
      </dl>

      <Table
        title="Pending"
        count={s.pending.length}
        empty="Nothing waiting for the server."
        head={['Seq', 'Operation', 'State', 'Age']}
        rows={s.pending.map((p) => ({
          key: p.seq,
          cells: [p.seq, p.op, p.state, formatDuration(now - Date.parse(p.at))],
        }))}
      />
      <Table
        title="Recent packets"
        count={s.packets.length}
        empty="No change received yet."
        head={['Id', 'Action', 'Model', 'Row', 'Age']}
        rows={s.packets.map((p) => ({
          key: p.id,
          cells: [
            p.id,
            ACTIONS[p.action],
            p.model,
            <code key="row">{p.rowId}</code>,
            age(p.appliedAt),
          ],
        }))}
      />
      <Table
        title="Rejections"
        count={s.rejections.length}
        empty="The server has rejected nothing."
        head={['Seq', 'Operation', 'Code', 'Message']}
        rows={s.rejections.map((r) => ({
          key: `${r.seq}-${r.op}`,
          cells: [r.seq, r.op, <code key="code">{r.code}</code>, r.message],
        }))}
      />
      <Table
        title="Rows"
        empty="No models."
        head={['Model', 'Rows']}
        rows={s.rows.map((r) => ({ key: r.model, cells: [r.model, r.count] }))}
      />
    </section>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Table({
  title,
  count,
  empty,
  head,
  rows,
}: {
  readonly title: string;
  readonly count?: number;
  readonly empty: string;
  readonly head: readonly string[];
  readonly rows: readonly { readonly key: string | number; readonly cells: readonly ReactNode[] }[];
}) {
  return (
    <section className={styles.section} aria-label={title}>
      <h3 className={styles.subtitle}>
        {title} {count === undefined ? null : <Badge count={count} />}
      </h3>
      {rows.length === 0 ? (
        <p className={styles.empty}>{empty}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              {head.map((cell) => (
                <th key={cell} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {row.cells.map((cell, n) => (
                  <td key={head[n] ?? n}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The current time, ticking every second while mounted. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The origin's storage usage, read on mount and every 10 s. */
function useStorageUsage(): number | undefined {
  const [usage, setUsage] = useState<number | undefined>(undefined);
  useEffect(() => {
    let mounted = true;
    const read = () => {
      void storageUsage().then((bytes) => {
        if (mounted) setUsage(bytes);
      });
    };
    read();
    const timer = setInterval(read, USAGE_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  return usage;
}
