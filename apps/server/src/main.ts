/**
 * Process entry point. Validates configuration before loading anything heavy,
 * so a misconfigured container exits fast with a clear message (SPEC-004 AC-6).
 * PLAN-004 S4 turns this into the `surface` CLI; `serve` is the default command.
 */
import { ConfigError, loadConfig, type Config } from './config.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const { serve } = await import('./server.js');
await serve(config);
