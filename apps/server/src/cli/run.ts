/**
 * `surface <command>` (SPEC-004 §9): argument parsing and dispatch.
 *
 * Commands load what they need on demand, so `surface serve` with a bad config
 * still exits within a second (AC-6) and `surface version` never needs a database
 * or a valid configuration.
 */
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { EXIT, type CliIo } from './io.js';

export interface CliOptions {
  /** Environment for `loadConfig()`; defaults to the process environment. */
  env?: NodeJS.ProcessEnv;
}

const USAGE = `Usage: surface <command> [options]

Commands:
  serve                   Run the server (the default)
  migrate                 Apply pending database migrations, then exit
  doctor [--json]         Check the configuration, database, data volume, email and public URL
  version [--json]        Print the version, commit and schema level
  setup-token             Print a fresh setup URL (not available yet)
  reset-password <email>  Print a one-time password reset link (not available yet)

Options:
  -h, --help              Show this help
  -V, --version           Same as "surface version"

Configuration comes from environment variables. Every one is documented in .env.example.
`;

interface CommandSpec {
  /** Positional arguments after the command name. */
  args: readonly string[];
  /** A sample of `args`, shown when they are missing. */
  example?: string;
  json: boolean;
}

const COMMANDS = {
  serve: { args: [], json: false },
  migrate: { args: [], json: false },
  doctor: { args: [], json: true },
  version: { args: [], json: true },
  'setup-token': { args: [], json: false },
  'reset-password': { args: ['email'], example: 'ada@example.com', json: false },
} as const satisfies Record<string, CommandSpec>;

type CommandName = keyof typeof COMMANDS;

function isCommand(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

class UsageError extends Error {}

interface Invocation {
  command: CommandName | 'help';
  json: boolean;
}

function parseFlags(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
        json: { type: 'boolean' },
      },
    });
  } catch (error) {
    // parseArgs explains unknown or malformed options in its message.
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function parse(argv: string[]): Invocation {
  const { values, positionals } = parseFlags(argv);
  if (values.help) return { command: 'help', json: false };

  if (values.version && positionals.length > 0) {
    throw new UsageError(`--version can't be combined with a command ("${positionals[0]}").`);
  }
  const [name = values.version ? 'version' : 'serve', ...rest] = positionals;
  if (!isCommand(name)) throw new UsageError(`Unknown command "${name}".`);

  const spec: CommandSpec = COMMANDS[name];
  if (rest.length < spec.args.length) {
    const needs = spec.args.map((a) => `<${a}>`).join(' ');
    const example = spec.example ? `, e.g. surface ${name} ${spec.example}` : '';
    throw new UsageError(`surface ${name} needs ${needs}${example}.`);
  }
  if (rest.length > spec.args.length) {
    throw new UsageError(`surface ${name} does not take "${rest[spec.args.length]}".`);
  }
  if (values.json && !spec.json) throw new UsageError(`surface ${name} does not support --json.`);
  return { command: name, json: values.json ?? false };
}

/** Load and validate config, printing the problems when it is invalid. */
function configOrExit(io: CliIo, env: NodeJS.ProcessEnv | undefined): Config | undefined {
  try {
    return loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`${error.message}\n`);
      return undefined;
    }
    throw error;
  }
}

/** Run the CLI and return the exit code. `serve` returns once the server is ready. */
export async function runCli(argv: string[], io: CliIo, options: CliOptions = {}): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parse(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`${error.message} Run "surface --help" to see the commands.\n`);
    return EXIT.usage;
  }

  switch (invocation.command) {
    case 'help':
      io.out(USAGE);
      return EXIT.ok;

    case 'version': {
      const { versionCommand } = await import('./version.js');
      return versionCommand(io, { json: invocation.json });
    }

    case 'serve': {
      const config = configOrExit(io, options.env);
      if (!config) return EXIT.failure;
      const { serve } = await import('../server.js');
      await serve(config);
      return EXIT.ok;
    }

    case 'migrate': {
      const config = configOrExit(io, options.env);
      if (!config) return EXIT.failure;
      const { migrateCommand } = await import('./migrate.js');
      return migrateCommand(config);
    }

    case 'doctor': {
      const { doctorCommand } = await import('./doctor/doctor.js');
      return doctorCommand(io, { json: invocation.json, env: options.env });
    }

    case 'setup-token':
    case 'reset-password':
      // SPEC-004 §9 lists both for M0; they need workspace setup (PLAN-001 S2).
      io.err(
        `surface ${invocation.command} is not available in this version yet. It arrives with workspace setup and sign-in (PLAN-001).\n`,
      );
      return EXIT.failure;
  }
}
