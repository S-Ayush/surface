# Troubleshooting

Run the commands here in the `docker/` directory. With your own PostgreSQL, set
`COMPOSE_FILE=docker-compose.external-db.yml` in `.env` (README step 4), so every `docker compose`
command uses that file.

## Start with `surface doctor`

```sh
docker compose exec app surface doctor
```

It checks the configuration, the database (reachable, version, ICU collations, extensions,
migrations), the data directory, free disk space, SMTP and the public URL. It changes nothing and
never prints secrets.

```
Surface doctor · version 1.4.2 (a20608a)

✓ Configuration       valid
✓ Database            connected to db:5432/surface
✓ PostgreSQL version  17.11 (Debian 17.11-1.pgdg13+2)
✓ Collations          und-x-icu available
✓ Extensions          pg_trgm installed
✓ Migrations          all 2 applied
✓ Data directory      /data is writable
✓ Disk space          28.4 GB free of 39.1 GB on /data
- Email (SMTP)        not configured: Surface runs without email and shows invite and reset links in the app instead
! Public URL          Could not reach https://surface.example.com from this host (getaddrinfo ENOTFOUND surface.example.com). …

No problems, 1 warning.
```

`✓` ok, `!` warning, `✗` problem, `-` skipped. It exits 1 if any line is a problem. Add `--json`
for scripts.

If the app container keeps restarting, `exec` can't reach it. Run doctor in a one-off container
instead:

```sh
docker compose run --rm app doctor
```

## Read the logs

```sh
docker compose logs --tail 50 app
```

Logs are JSON, one line per event. A startup failure is the last `"level":"fatal"` line, and its
`msg` says what to fix. Configuration errors are the exception: they appear as a plain-text block
([below](#configuration-errors)). For more detail, set `LOG_LEVEL=debug` in `.env` and run
`docker compose up -d`.

## Compose refuses to start

**`required variable POSTGRES_PASSWORD is missing a value`** (or `DATABASE_URL` with
`docker-compose.external-db.yml`): `.env` is missing, not in the `docker/` directory, or the value
is empty. See step 3 of the [README](../../README.md#3-configure).

**`env file …/docker/.env not found`**: create it with `cp .env.example .env`.

**A value in `.env` lost a `$`**: Compose expands `$` in `.env`. Write a literal `$` as `$$`. The
generated hex secrets never contain one.

## Configuration errors

Surface checks all settings at startup and exits within a second, listing every problem at once
as plain text (not JSON). Each line names the variable and the fix, for example:

```
Surface cannot start: the configuration is invalid.

  ✗ SESSION_SECRET is missing. Generate one with: openssl rand -hex 32
  ✗ SURFACE_URL must be just the origin, without a path, query or credentials (got "https://example.com/surface"). Serving Surface under a sub-path is not supported.
```

Fix `.env` and run `docker compose up -d`. Secrets are never echoed in these messages.

## Database problems

### Waiting for the database, then exit

```
waiting for database…
Could not reach the database at db:5432/surface after 60 s (ECONNREFUSED: …). Check that it is running and that DATABASE_URL points to it.
```

The bundled database: run `docker compose ps db` and `docker compose logs db`. A full disk or a
damaged volume stops PostgreSQL from starting.

Your own database: check the host and port in `DATABASE_URL`, and that the server accepts
connections from the Docker host (`listen_addresses`, firewalls, security groups).

Compose restarts Surface after it exits, so it recovers by itself once the database is back.

### The database rejected the username or password

```
The database rejected the username or password in DATABASE_URL (or POSTGRES_PASSWORD). Check that they match the database server.
```

With the bundled database, this almost always means `POSTGRES_PASSWORD` changed after the first
start. PostgreSQL stores the password when the volume is created and ignores the variable after
that. Either put the old value back in `.env`, or set the database to the new one. `\password`
asks for it twice and keeps it out of your shell history:

```sh
docker compose exec db psql -U surface -d surface -c '\password surface'
docker compose up -d
```

### The database server refused this connection (pg_hba.conf)

Most managed databases only accept TLS. Add `?sslmode=require` to `DATABASE_URL`. Otherwise, ask
the database administrator to allow this host, user and database in `pg_hba.conf`.

### The database named in DATABASE_URL does not exist

Create it (`CREATE DATABASE surface OWNER surface;`) or fix the name at the end of `DATABASE_URL`.

### Surface needs PostgreSQL 17 or newer

Surface stops before changing anything. Upgrade the server, or move to the bundled `postgres:17`
by restoring a dump ([backup-manual.md](backup-manual.md)).

### The PostgreSQL collation "und-x-icu" is missing

```
The PostgreSQL collation "und-x-icu" is missing, so this server was built without ICU support. Use a PostgreSQL build with ICU, such as the official postgres:17 image.
```

Surface lowercases text for filters with the ICU root collation. The official `postgres` images and
most managed databases include ICU; some self-compiled or minimal builds don't. Switch to a build
with ICU, or move to the bundled `postgres:17` by restoring a dump
([backup-manual.md](backup-manual.md)). Surface stops before changing anything.

### The PostgreSQL extension pg_trgm is not installed

```
The PostgreSQL extension pg_trgm is not installed and the database user is not allowed to create it. Ask a database administrator to run this in database "surface": CREATE EXTENSION pg_trgm;
```

Run that SQL as an administrator, then restart Surface. If the message says the extension is **not
available**, install your distribution's PostgreSQL contrib package, or enable `pg_trgm` in your
provider's settings.

### Database was migrated by a newer Surface

```
Database was migrated by a newer Surface (1.5.0). Restore a backup or upgrade.
```

You started an older image on a database a newer one has migrated. Set `SURFACE_VERSION` to the
version named in the message or newer, or restore a backup taken with the older one. See
[upgrade.md](upgrade.md#rolling-back).

### Migration … has changed since it was applied

The image contains an edited copy of a migration that already ran. Released images never do
this, but an image built from an unreleased commit can. Rebuild from a release, or from the commit
that first applied the migration.

### Migration … failed and was rolled back

That migration left the database unchanged, but migrations commit one at a time: those before it
in the same upgrade stay applied. Keep the log line and report it.

- No `applied migration` lines before the failure: set `SURFACE_VERSION` back to the previous
  version and run `docker compose up -d`.
- `applied migration` lines before it: the previous version will refuse the database. Restore the
  backup taken before the upgrade ([upgrade.md](upgrade.md#rolling-back)), or wait for a fix.

## Sign-in fails, or the page loads from the wrong address

`SURFACE_URL` must be exactly the origin people type into the browser: scheme, host and port, no
path. `https://surface.example.com` and `http://surface.example.com:3000` are different origins.
Sign-in fails when they don't match.

- Behind a proxy, use the public `https://` address, not `http://localhost:3000`.
- Without a proxy, include the port: `http://<server address>:3000`.

After changing it, run `docker compose up -d`. Doctor's "Public URL" line requests
`SURFACE_URL/healthz` from the server itself:

- `… redirects (301) to …`: the proxy redirects, for example http → https. Set `SURFACE_URL` to
  the address it redirects to.
- `… answered 404 but not as Surface`: something else answers at that address. Check where the
  proxy forwards it.
- `… reaches Surface, but over plain http`: sign-in cookies travel unencrypted. Put Surface
  behind an HTTPS proxy ([reverse-proxy.md](reverse-proxy.md)).
- `Could not reach … from this host`: often harmless. Many servers can't reach their own public
  address (split DNS, NAT). Check from your own computer instead:
  `curl -sS https://surface.example.com/readyz`.

## Live updates unavailable

The proxy isn't passing WebSocket upgrades on `/sync/`, or it closes idle connections too early.
Changes from teammates then only show up after a reload. Caddy and Traefik need nothing extra. For
nginx, add the `Upgrade`/`Connection` headers and `proxy_read_timeout 1h`: see
[reverse-proxy.md](reverse-proxy.md#nginx). Load balancers in front of the proxy need the same.

## Data directory and disk

### Data directory not writable

Surface exits at startup with one of these lines, and `surface doctor` reports the same (SPEC-004
E5). Surface runs as uid 10001 and stores uploads in `/data/uploads`, its own volume in the
compose files; startup checks `/data` and `/data/uploads`.

- `Surface cannot write to /data/uploads (…)` (or `/data`): the volume isn't writable by uid
  10001. The named volumes in the compose files get the right owner automatically. If you
  replaced them with bind mounts to host directories, give those directories to uid 10001:

  ```sh
  sudo chown -R 10001:10001 /srv/surface/uploads /srv/surface/backups
  ```

- `/data does not exist. Mount a volume there, or point DATA_DIR at an existing directory.`: a
  `DATA_DIR` you set points nowhere (the image creates `/data`). Outside Docker, create the
  directory first.
- `… is not a directory. …`: `DATA_DIR`, or `uploads` inside it, is a file. Point `DATA_DIR` at a
  directory, or remove the file.

Startup creates a missing `uploads` folder. `backups` isn't checked: the server doesn't write it.

### Low disk space

Doctor warns under 1 GB free and reports a problem under 100 MB. Check with `df -h`. Docker's own
usage: `docker system df`. Old images from earlier upgrades are a common cause:
`docker image prune` removes the ones no container uses.

### Disk space isn't freed right after a file is removed

Removing an attachment, or replacing an avatar or logo, frees nothing at once. The hourly
`files-cleanup` job deletes unclaimed uploads, removed attachments and unused avatars and logos
24 hours later, then unlinks their bytes when no other file uses the same bytes. The daily
`files-sweep` job removes bytes no file names and temporary upload files older than an hour
(SPEC-014 §4.5, §4.6). Look for `files cleanup` and `files sweep` in the logs. With
`METRICS_ENABLED=true`, `surface_files_stored_bytes` and `surface_files_blob_release_backlog`
show stored bytes and the bytes waiting to be unlinked.

### Separate worker containers (`SURFACE_ROLE=worker`)

The file jobs run where jobs run: in `SURFACE_ROLE=all` (the default) or in a `worker`
container. A `worker` must mount the **same** `uploads` volume as the `web` containers, at the
same `DATA_DIR`. With a volume of its own, the jobs clean that one instead, and the real uploads
volume fills up with bytes nothing removes.

### Leftover empty volumes

The image declares `/data` as a volume, so each new app container gets a small anonymous volume
there. After `docker compose down` and `up`, the old one stays behind, unused and empty: your
uploads and backups live in the named `uploads` and `backups` volumes. Remove leftovers with:

```sh
docker compose up -d       # with the stack running, its own volumes are in use and kept
docker volume prune        # Docker 23+: removes only unused anonymous volumes
```

Check `docker version` first: before Docker 23, `docker volume prune` also deletes unused named
volumes, so a stopped stack would lose its database. Never use `docker compose down -v` or
`docker volume prune -a` to clean up: they delete the database and uploads too.

## Container is unhealthy or restarts

`docker compose ps` shows the state. `unhealthy` means `/healthz` stopped answering: the logs
usually say why. A restart loop is almost always a startup error: read the last log lines (above).

Surface needs up to 15 s to stop cleanly, and the compose files allow 20 s
(`stop_grace_period`). If you run the image with plain `docker run`, pass `--stop-timeout 20`,
or Docker kills it after 10 s mid-shutdown.

## Caddy fails with a Caddyfile directory

`docker compose --profile proxy up` ran before `Caddyfile` existed, so Docker created a directory
by that name. Remove it and copy the example:

```sh
docker compose --profile proxy down
rmdir Caddyfile && cp Caddyfile.example Caddyfile      # then set your domain
docker compose --profile proxy up -d
```

## Port already in use

`Bind for 0.0.0.0:3000 failed: port is already allocated`: another program uses port 3000 on the
host. Set `SURFACE_PORT` in `.env` to a free port (and update `SURFACE_URL` if it includes the
port). Leave `PORT` alone: it is the port inside the container.

## Still stuck

Collect `docker compose exec app surface version`, `surface doctor --json` and the last 100 log
lines. Passwords and tokens are kept out of the logs, with one exception: until setup is complete,
the logs contain the one-time setup link. Remove it, and any host names you'd rather not share,
before posting the logs anywhere.
