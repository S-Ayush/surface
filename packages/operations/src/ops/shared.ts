/** Schemas the SPEC-001 operation files share (PLAN-001 S7). Not part of the package's exports. */
import { z } from 'zod';

/** An ISO 8601 instant with its offset, as every output timestamp is written. */
export const Timestamp = z.iso.datetime({ offset: true });
