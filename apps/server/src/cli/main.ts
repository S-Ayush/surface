/**
 * Entry point of the `surface` CLI (`bin/surface.js` loads the built copy).
 * Imports stay minimal here: see run.ts.
 */
import { runCli } from './run.js';

const io = {
  out: (text: string) => void process.stdout.write(text),
  err: (text: string) => void process.stderr.write(text),
};

// Set the exit code instead of calling process.exit(), so buffered output is
// flushed. `serve` keeps running after runCli returns; signals end it.
process.exitCode = await runCli(process.argv.slice(2), io);
