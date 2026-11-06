#!/usr/bin/env node
// The development loop (SPEC-004 §3, PLAN-004 S5).
//
//   node scripts/dev.mjs             `pnpm dev`: start PostgreSQL, apply migrations, then
//                                    run the server (tsx watch) and Vite with HMR side by side
//   node scripts/dev.mjs db:migrate  `pnpm db:migrate`: apply migrations to the dev database
//   node scripts/dev.mjs db:down     `pnpm dev:db:down`: stop the dev database (data is kept)
//
// Open SURFACE_URL (Vite, http://localhost:5173): it proxies server routes to the server.
// Each checkout gets its own database container and volume (compose project
// surface-dev-<folder>), so git worktrees never share or stop each other's database.
//
// Defaults come from apps/server/dev.env. To run next to another checkout, override:
//   PORT                  server port (default 3000)
//   SURFACE_DEV_WEB_PORT  Vite port (default 5173); SURFACE_URL follows it
//   SURFACE_DEV_PG_PORT   PostgreSQL port (default 5432); DATABASE_URL follows it
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const project = `surface-dev-${path
  .basename(root)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-')}`;
const compose = ['compose', '-p', project, '-f', 'docker/docker-compose.dev.yml'];

const env = { ...process.env };
env.PORT ??= '3000';
env.SURFACE_DEV_WEB_PORT ??= '5173';
env.SURFACE_DEV_SERVER_URL ??= `http://localhost:${env.PORT}`;
// Values in the environment win over apps/server/dev.env (Node --env-file).
if (process.env.SURFACE_DEV_WEB_PORT) {
  env.SURFACE_URL ??= `http://localhost:${env.SURFACE_DEV_WEB_PORT}`;
}
if (process.env.SURFACE_DEV_PG_PORT) {
  env.DATABASE_URL ??= `postgres://surface:surface@localhost:${env.SURFACE_DEV_PG_PORT}/surface`;
}

function step(what, command, args, hint) {
  process.stdout.write(`→ ${what}\n`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`✗ ${what} failed.${hint ? ` ${hint}` : ''}\n`);
    process.exit(result.status ?? 1);
  }
}

const startDatabase = () =>
  step(
    `starting PostgreSQL (compose project ${project})`,
    'docker',
    [...compose, 'up', '-d', '--wait'],
    'Is Docker running (colima start, or Docker Desktop)? Is the port free? Set SURFACE_DEV_PG_PORT to use another one.',
  );
const migrate = () =>
  step('applying migrations', 'pnpm', ['--filter', '@surface/server', 'surface', 'migrate']);

const command = process.argv[2] ?? 'up';
switch (command) {
  case 'db:down':
    step(`stopping PostgreSQL (compose project ${project})`, 'docker', [...compose, 'down']);
    break;

  case 'db:migrate':
    startDatabase();
    migrate();
    break;

  case 'up': {
    startDatabase();
    // DATA_DIR in apps/server/dev.env (gitignored).
    mkdirSync(path.join(root, 'data'), { recursive: true });
    migrate();

    process.stdout.write(
      `→ server on ${env.SURFACE_DEV_SERVER_URL}, web on http://localhost:${env.SURFACE_DEV_WEB_PORT}\n`,
    );
    const child = spawn(
      'pnpm',
      ['--parallel', '--filter', '@surface/server', '--filter', '@surface/web', 'run', 'dev'],
      { cwd: root, env, stdio: 'inherit' },
    );
    // Ctrl-C already reaches the whole process group; forwarding it again would
    // make the server see a second signal and force-exit. Just wait for the children.
    process.on('SIGINT', () => undefined);
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    break;
  }

  default:
    process.stderr.write(`Unknown command "${command}". Use db:migrate, db:down or nothing.\n`);
    process.exit(2);
}
