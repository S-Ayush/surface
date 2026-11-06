#!/usr/bin/env node
// The `surface` command (SPEC-004 §9). It runs the built server (`pnpm build`);
// in development use `pnpm --filter @surface/server surface <command>` instead.
import '../dist/cli/main.js';
