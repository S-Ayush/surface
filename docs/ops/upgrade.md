# Upgrading Surface

An upgrade is a tag change: set the new version, pull, and recreate the container. Surface applies
its database migrations itself at startup (SPEC-004 §8). Expect under a minute of downtime.

**Migrations are forward-only.** Once a new version has migrated the database, an older version
refuses to start on it. Rolling back means restoring the backup you take in step 1.

## Versions

Images are tagged `x.y.z` (one release), `x.y` (the newest patch of a minor version) and `latest`.
Pin a version in `.env` so upgrades happen when you choose:

```sh
SURFACE_VERSION=1.4.2
```

Upgrading one minor version at a time (1.3 → 1.4 → 1.5) needs no manual steps. Read the release
notes before skipping versions.

## Upgrade

Run these in the `docker/` directory.

1. **Back up** the database and uploads ([backup-manual.md](backup-manual.md)).

2. **Set the new version** in `.env`, for example `SURFACE_VERSION=1.5.0`.

3. **Pull and restart:**

   ```sh
   docker compose pull app
   docker compose up -d
   ```

   Add `--profile proxy` to both if you use the bundled Caddy (or set `COMPOSE_PROFILES=proxy` in
   `.env`). With your own database, `COMPOSE_FILE` in `.env` picks the right compose file (README
   step 4).

4. **Watch it start:**

   ```sh
   docker compose logs -f app
   ```

   Look for `applied migration` (once per new migration), then `Surface is ready`. Press Ctrl-C to
   stop following the logs.

5. **Check:**

   ```sh
   docker compose exec app surface version
   docker compose exec app surface doctor
   ```

Open browser tabs reconnect on their own.

### Compose file changes

A release can also change the files in `docker/`. The release notes say when. Releases will be
tagged `vX.Y.Z` in the repository: take the compose files from the tag that matches
`SURFACE_VERSION`, not from the latest commit, which may expect settings your version doesn't
have. For example, from 1.4.2 to 1.5.0:

```sh
git -C .. fetch --depth 1 origin tag v1.4.2 tag v1.5.0
git -C .. diff v1.4.2 v1.5.0 -- docker/      # what changed
git -C .. checkout v1.5.0
```

Your `.env` and `Caddyfile` are not tracked, so a checkout never overwrites them. New settings
appear in `.env.example` with their defaults.

### Builds from source

Until the first release is published, there are no images or tags. Rebuild the image from the
latest commit instead of step 3:

```sh
git -C .. pull
docker build -f ../docker/Dockerfile -t ghcr.io/s-ayush/surface:latest ..
docker compose up -d
```

## Migrating ahead of the restart

Migrations normally run when the new container starts. To run them separately, for example in a
maintenance window before restarting:

```sh
docker compose run --rm app migrate
```

It waits for the database, applies pending migrations under a lock and exits. The running old version
reports `/readyz` 503 once it sees migrations it doesn't know, so restart it right after.

## Several replicas

The migration lock makes replicas that start together take turns, so only one applies migrations.
Once a newer replica has migrated, older ones answer `/readyz` with 503 (`"migrations": "failing"`)
so the proxy stops sending them traffic. Replace all replicas promptly.

## Rolling back

What to do depends on whether the new version reached the database.

**It failed before migrating** (for example a configuration error, or the database was unreachable):
nothing has changed. Set `SURFACE_VERSION` back and run `docker compose up -d`.

**It migrated, and you need the old version:** the old version refuses to start with

```
Database was migrated by a newer Surface (1.5.0). Restore a backup or upgrade.
```

The same happens when an upgrade applied some migrations and then failed on another: each
migration commits on its own, so the ones before the failure stay applied. To go back:

1. Set `SURFACE_VERSION` back to the version you backed up from.
2. Restore the backup you took in step 1 ([backup-manual.md](backup-manual.md#restore)).
3. `docker compose up -d`.

Anything changed in Surface since that backup is lost. Prefer fixing forward when you can: report
the problem and wait for a patch release.

## PostgreSQL

Surface needs PostgreSQL 17 or newer. The bundled `postgres:17` image gets bug-fix updates with:

```sh
docker compose pull db
docker compose up -d db
```

A major PostgreSQL upgrade (17 → 18) can't reuse the data volume. Back up with `pg_dump`, start the
new major version on a fresh volume, and restore ([backup-manual.md](backup-manual.md)). The
`pg_dump` client in the Surface image is version 17, so dump a newer server with that server's own
tools.
