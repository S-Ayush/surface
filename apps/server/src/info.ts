import { STATUS_CATEGORIES } from '@surface/domain';
import { SYNC_PROTOCOL_VERSION } from '@surface/sync-protocol';

export interface ServerInfo {
  name: string;
  protocolVersion: number;
  statusCategories: number;
}

export function serverInfo(): ServerInfo {
  return {
    name: 'surface',
    protocolVersion: SYNC_PROTOCOL_VERSION,
    statusCategories: STATUS_CATEGORIES.length,
  };
}
