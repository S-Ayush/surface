/**
 * The `files` rows (server-only, ADR-0014; PLAN-001 S6). Uploading writes one; nothing synced
 * changes until an operation names the file (`user.updateProfile`, `workspace.update`).
 */
import { and, eq, exists, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { files, users, workspace, type FilePurpose } from '../db/schema/index.js';

type Db = pg.PoolClient;

export interface NewFile {
  readonly id: string;
  readonly storageKey: string;
  readonly purpose: FilePurpose;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploaderId: string;
}

export interface ReadableFile {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface FileStore {
  insert(client: Db, file: NewFile): Promise<void>;
  /**
   * The file if `userId` may see it, else undefined (shown as not found). Avatars and the logo
   * are workspace-wide (their users and workspace rows sync to everyone); an upload nothing
   * names yet is its uploader's alone.
   */
  readable(client: Db, fileId: string, userId: string): Promise<ReadableFile | undefined>;
}

export const PG_FILE_STORE: FileStore = {
  async insert(client, file) {
    await drizzle({ client, casing: 'snake_case' }).insert(files).values(file);
  },
  async readable(client, fileId, userId) {
    const db = drizzle({ client, casing: 'snake_case' });
    const [row] = await db
      .select({ storageKey: files.storageKey, mimeType: files.mimeType, size: files.size })
      .from(files)
      .where(
        and(
          eq(files.id, fileId),
          or(
            eq(files.uploaderId, userId),
            exists(
              db
                .select({ one: sql`1` })
                .from(users)
                .where(eq(users.avatarFileId, files.id)),
            ),
            exists(
              db
                .select({ one: sql`1` })
                .from(workspace)
                .where(eq(workspace.logoFileId, files.id)),
            ),
          ),
        ),
      );
    return row;
  },
};
