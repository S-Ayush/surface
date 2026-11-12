// Where an uploaded file's bytes are served (ADR-0014; PLAN-001 S6): avatars and the logo are
// synced as ids (`User.avatarFileId`, `Workspace.logoFileId`), and the browser loads the bytes.
// For the shell too (sidebar, avatar menu): pass it to `Avatar`'s `src`.
export function fileUrl(fileId: string | null | undefined): string | undefined {
  return fileId === null || fileId === undefined ? undefined : `/files/${fileId}`;
}
