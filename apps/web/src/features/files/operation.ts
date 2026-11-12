// One operation over `POST /api/ops/:name` (SPEC-003 §9), for the requests that don't go through
// the store: an answer someone is waiting for (an upload's id, the sessions list) or a secret
// the mutation queue must never keep (a password; PLAN-001 S6).
import type { AnyOperation, InputOf } from '@surface/operations';
import { z } from 'zod';
import type { FetchLike } from '../../app/http.js';

export const UNREACHABLE = "Couldn't reach Surface. Check your connection, then try again.";

export type OperationAnswer<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** The input field a refusal is about, when it names one. */
      readonly field?: string;
    };

const Refusal = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])) })).optional(),
  }),
});

const unreachable = { ok: false, code: 'UNREACHABLE', message: UNREACHABLE } as const;

export async function postOperation<Op extends AnyOperation, Output extends z.ZodType>(
  send: FetchLike,
  op: Op & { readonly output: Output },
  input: InputOf<Op>,
): Promise<OperationAnswer<z.output<Output>>> {
  let response: Response;
  try {
    response = await send(`/api/ops/${op.name}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    });
  } catch {
    return unreachable;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unreachable;
  }
  if (!response.ok) {
    // A refusal says what to do; a server failure's message is never shown (SPEC-003).
    const refusal = response.status < 500 ? Refusal.safeParse(body) : undefined;
    if (!refusal?.success) return unreachable;
    const field = refusal.data.error.issues?.[0]?.path[0];
    return {
      ok: false,
      code: refusal.data.error.code,
      message: refusal.data.error.message,
      ...(typeof field === 'string' ? { field } : {}),
    };
  }
  const parsed = op.output.safeParse(
    typeof body === 'object' && body !== null ? Reflect.get(body, 'result') : undefined,
  );
  return parsed.success ? { ok: true, result: parsed.data } : unreachable;
}
