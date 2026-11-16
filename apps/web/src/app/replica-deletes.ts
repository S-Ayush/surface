// A replica delete that failed after a successful logout (SPEC-012 §3.12): the user is signed out,
// so the delete is remembered by name (a database name holds two ids, no secret) and retried at
// the next load, before any store opens that database.
import { deleteReplicaDatabase } from '@surface/sync-client';

const KEY = 'surface.pending-replica-deletes';

type Kv = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The names kept, in `localStorage` where it works. Every access is guarded. */
export interface ReplicaDeleteMarks {
  list(): readonly string[];
  add(name: string): void;
  remove(name: string): void;
}

export function browserReplicaDeleteMarks(storage: () => Kv): ReplicaDeleteMarks {
  const read = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(storage().getItem(KEY) ?? '[]');
      return Array.isArray(parsed)
        ? parsed.filter((name): name is string => typeof name === 'string')
        : [];
    } catch {
      return [];
    }
  };
  const write = (names: readonly string[]) => {
    try {
      if (names.length === 0) storage().removeItem(KEY);
      else storage().setItem(KEY, JSON.stringify(names));
    } catch {
      // Not kept: the replica stays until the next sign-out of that user deletes it.
    }
  };
  return {
    list: read,
    add: (name) => {
      const names = read();
      if (!names.includes(name)) write([...names, name]);
    },
    remove: (name) => {
      write(read().filter((kept) => kept !== name));
    },
  };
}

/** Deletes the remembered replicas; one that fails stays remembered for the next load. */
export async function retryReplicaDeletes(
  marks: ReplicaDeleteMarks,
  remove: (name: string) => Promise<void> = deleteReplicaDatabase,
): Promise<void> {
  for (const name of marks.list()) {
    try {
      await remove(name);
      marks.remove(name);
    } catch {
      // Still not deletable: tried again at the next load.
    }
  }
}
