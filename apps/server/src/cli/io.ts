/** Output and exit codes shared by the CLI commands. */
export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** 0 = success, 1 = the command failed, 2 = it was called wrongly. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;
