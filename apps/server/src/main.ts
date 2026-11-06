// Entry point. PLAN-004 S2 replaces this with config loading and the Fastify app.
import { serverInfo } from './info.js';

process.stdout.write(`${JSON.stringify({ msg: 'surface server skeleton', ...serverInfo() })}\n`);
