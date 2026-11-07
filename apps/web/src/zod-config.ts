import { z } from 'zod';

// Zod probes `new Function('')` when the first object schema is created, to decide whether
// to JIT parsers. Under the CSP (SPEC-004 §15, no 'unsafe-eval') the caught probe still
// reports a `script-src` violation on every load. `main.tsx` imports this module
// first, so it runs before any module that builds a `z.object()` at load (PLAN-004 S9).
z.config({ jitless: true });
