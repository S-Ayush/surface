// Which applied packets change a team's archive (SPEC-015 §3.3 item 6, E24; PLAN-015 S4), and a
// refresh that runs at most once a second, because auto-archive emits many `A`s at once. The
// archive page's source and the team list's "N archived issues" share it. Only while the team is
// subscribed: an unsubscribed team's packets never reach this tab, and focus refreshes instead.

/** Refreshes run at most this often (§3.3 item 6). */
export const PACKET_REFRESH_MS = 1_000;

/** An applied delta packet, as the store's `recentPackets` reports it. */
export interface ArchivePacket {
  readonly id: number;
  readonly action: 'I' | 'U' | 'A' | 'V' | 'D';
  readonly model: string;
  readonly rowId: string;
  /**
   * The row's team, from the packet itself: an archived or deleted Issue never reaches the pool,
   * so the pool can't say (sync-client `AppliedPacket.teamId`). Absent on a `D`.
   */
  readonly teamId?: string;
}

export interface PacketWatchDeps {
  /** Whether this tab receives the team's deltas (a member team, or one opened on demand). */
  subscribed(teamId: string): boolean;
  /** The team of an issue the replica holds now; undefined when it holds none. */
  teamOf(issueId: string): string | undefined;
  /** Calls back with packets applied from now on, oldest first. Returns the stop function. */
  watchPackets(listener: (packets: readonly ArchivePacket[]) => void): () => void;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

/**
 * Whether `packet` may change team `teamId`'s archive: an Issue `A` (archived) or `V` (restored
 * from archive) of the team; a `U` of the team whose row isn't held after it (a delete), or that a
 * list shows (a restore); a `D` (purge) of a row a list shows. A live edit, an insert, another
 * team's row and other models never do.
 */
export function concernsArchive(
  packet: ArchivePacket,
  teamId: string,
  deps: Pick<PacketWatchDeps, 'teamOf'>,
  listed: (issueId: string) => boolean,
): boolean {
  if (packet.model !== 'Issue') return false;
  const held = deps.teamOf(packet.rowId);
  const team = packet.teamId ?? held;
  if (team !== undefined && team !== teamId) return false;
  switch (packet.action) {
    case 'A':
    case 'V':
      return team === teamId;
    case 'U':
      // Held after the packet: a live edit, unless the list shows it (restored elsewhere).
      return held === undefined || listed(packet.rowId);
    case 'D':
      return listed(packet.rowId);
    case 'I':
      return false;
  }
}

/**
 * Watches the team's packets and runs `refresh` at most once per `PACKET_REFRESH_MS` after one
 * that concerns the archive. Returns the stop function, which also drops a pending refresh.
 */
export function watchArchivePackets(
  deps: PacketWatchDeps,
  teamId: string,
  listed: (issueId: string) => boolean,
  refresh: () => void,
): () => void {
  let timer: unknown;
  const stopWatching = deps.watchPackets((packets) => {
    if (!deps.subscribed(teamId) || timer !== undefined) return;
    if (!packets.some((packet) => concernsArchive(packet, teamId, deps, listed))) return;
    timer = deps.setTimeout(() => {
      timer = undefined;
      refresh();
    }, PACKET_REFRESH_MS);
  });
  return () => {
    stopWatching();
    if (timer !== undefined) deps.clearTimeout(timer);
    timer = undefined;
  };
}
