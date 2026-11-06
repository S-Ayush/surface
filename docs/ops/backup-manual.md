# Manual backup and restore

Scheduled backups and `surface backup` / `surface restore` arrive in a later milestone. Until then,
back up by hand or with the script below. Run the commands in the `docker/` directory.

With your own PostgreSQL, set `COMPOSE_FILE=docker-compose.external-db.yml` in `.env` (README
step 4), so every `docker compose` command here uses that file.

## What to keep

| What | Where | How |
| --- | --- | --- |
| Database | `pgdata` volume (bundled) or your PostgreSQL | `pg_dump`, below |
| Uploaded files | `uploads` volume, `/data/uploads` in the container | `tar`, below |
| Configuration | `docker/.env`, `docker/Caddyfile` | Copy them. `.env` holds secrets: store it encrypted. |

A backup contains everything in Surface, so only you should be able to read it. Store copies off
the host: a backup on the same disk doesn't survive losing that disk.

## Back up by hand

```sh
umask 077          # new files readable only by you
docker compose exec -T db pg_dump -U surface surface | gzip > surface-$(date +%F).sql.gz
docker compose exec -T app tar czf - -C /data uploads > uploads-$(date +%F).tar.gz
```

`pg_dump` takes a consistent snapshot while Surface keeps running. Keep the `-T`: without it,
Docker can allocate a terminal and corrupt the output with carriage returns.

If `pg_dump` fails, `gzip` still writes a small, empty archive. Check for an error message, or
check that the file is more than a few hundred bytes.

**With your own PostgreSQL**, dump with the `pg_dump` 17 in the Surface image, which reads the
same `DATABASE_URL`:

```sh
docker compose exec -T app sh -c 'pg_dump --no-owner --no-privileges "$DATABASE_URL"' | gzip > surface-$(date +%F).sql.gz
```

`pg_dump` refuses to dump a server newer than itself. For PostgreSQL 18 or later, use that server's
own `pg_dump` or your provider's backups.

## Back up every day

Save this as `/opt/surface/backup.sh` (adjust the `cd` to your `docker/` directory) and make it
executable with `chmod 700 /opt/surface/backup.sh`. It stops at the first error and deletes old
backups only after both new ones succeeded, so a broken night never costs you the good copies.

```bash
#!/usr/bin/env bash
# Daily Surface backup: keeps the newest 14 of each kind in docker/backups/.
set -euo pipefail
umask 077
cd /opt/surface/docker
mkdir -p backups
day=$(date +%F)

# With your own PostgreSQL, dump with the app container instead of `db`:
#   docker compose exec -T app sh -c 'pg_dump --no-owner --no-privileges "$DATABASE_URL"' | gzip > …
docker compose exec -T db pg_dump -U surface surface | gzip > backups/.surface.sql.gz.partial
mv backups/.surface.sql.gz.partial "backups/surface-$day.sql.gz"

docker compose exec -T app tar czf - -C /data uploads > backups/.uploads.tar.gz.partial
mv backups/.uploads.tar.gz.partial "backups/uploads-$day.tar.gz"

ls -1t backups/surface-*.sql.gz | tail -n +15 | xargs -r rm --
ls -1t backups/uploads-*.tar.gz | tail -n +15 | xargs -r rm --
```

Run it at 03:00 from the crontab of root or of a user in the `docker` group (`crontab -e`):

```cron
0 3 * * * /opt/surface/backup.sh 2>&1 | logger -t surface-backup
```

Failures appear in the system log (`journalctl -t surface-backup`). Copy `backups/` off the host
with the tool you already use.

## Restore

A restore replaces everything in Surface with the backup. Use the same Surface version the backup
was taken with, or a newer one: an older version refuses a database migrated by a newer one.

On a new host, first follow the [README](../../README.md) install with the **same `.env`**
(`SESSION_SECRET` and `POSTGRES_PASSWORD` included), and run `docker compose up -d` once.

1. **Stop Surface**, keeping the database running:

   ```sh
   docker compose stop app
   ```

2. **Replace the database** with the backup:

   ```sh
   docker compose exec -T db dropdb -U surface --force surface
   docker compose exec -T db createdb -U surface surface
   gunzip -c surface-2026-11-06.sql.gz | docker compose exec -T db psql -U surface -d surface -v ON_ERROR_STOP=1 --single-transaction -q > /dev/null
   ```

   With your own PostgreSQL, run the same steps with your administrator's tools: drop and recreate
   the database, then load the dump with `psql`. The database user in `DATABASE_URL` must own the
   restored objects, or run the restore as that user.

3. **Replace the uploaded files:**

   ```sh
   docker compose run --rm -T --no-deps --entrypoint sh app \
     -c 'rm -rf /data/uploads/* && tar xzf - -C /data' < uploads-2026-11-06.tar.gz
   ```

4. **Start Surface:**

   ```sh
   docker compose up -d
   docker compose exec app surface doctor
   ```

   If the Surface version is newer than the backup, it migrates the restored database on start.

Test a restore now and then, on a spare machine or a copy of the stack. A backup you haven't
restored is a guess.

## Don't lose the volumes

`docker compose down` keeps your data. **`docker compose down -v` deletes it**: the database, the
uploads and Caddy's certificates. Never add `-v` unless you mean to start from nothing.
