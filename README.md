# Surface

A self-hosted, keyboard-first issue tracker for small teams. One install serves one organisation:
a Docker image plus PostgreSQL on a machine you own. The client keeps a replica of the workspace,
so lists, boards, filters and search work without a round-trip to the server.

Surface makes no outbound network calls except to your own SMTP server. That rules out telemetry,
update checks, CDNs and external fonts.

> **Status: early development.** The install path below works: the image, configuration checks,
> migrations, health checks and the `surface` CLI. Workspace setup and sign-in arrive with the next
> milestone ([PLAN-001](docs/07-plans/PLAN-001-workspace-auth-members-teams.md)). Until then the app
> shows an empty shell. There is no published image yet, so step 2 builds it from source.

## Install (about 15 minutes)

**You need:**

- a Linux machine with 2 vCPU, 2 GB RAM and 20 GB disk (for example an Ubuntu LTS VM);
- [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin
  (`docker compose version` works);
- for HTTPS, a domain name whose DNS record points at the machine, with ports 80 and 443 open.

### 1. Get the files

```sh
git clone --depth 1 https://github.com/s-ayush/surface.git
cd surface
```

Everything you run lives in [`docker/`](docker/): the compose files, `.env.example` and
`Caddyfile.example`.

### 2. Get the image

Released versions are pulled from `ghcr.io/s-ayush/surface` by `docker compose up`, so there is
nothing to do. **Until the first release**, build the image from the clone (a few minutes):

```sh
docker build -f docker/Dockerfile -t ghcr.io/s-ayush/surface:latest .
```

### 3. Configure

```sh
cd docker
cp .env.example .env
sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/; s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
```

Then open `.env` and set `SURFACE_URL` to the address people will type into the browser:

- with HTTPS (step 4b or your own proxy): `https://surface.example.com`;
- without a proxy, on a trusted network: `http://<server address>:3000`.

Sign-in only works from exactly that origin. Every other setting is optional and documented in
`.env.example`.

Keep a copy of `.env` somewhere safe: it holds the secrets your backups need. `POSTGRES_PASSWORD`
takes effect when the database is first created; changing it later breaks the connection (see
[troubleshooting](docs/ops/troubleshooting.md#the-database-rejected-the-username-or-password)).

### 4. Start

**a. Without a proxy:**

```sh
sed -i 's/^#TRUST_PROXY=.*/TRUST_PROXY=false/' .env   # no proxy: ignore X-Forwarded-* headers
docker compose up -d
```

**b. With the bundled Caddy for automatic HTTPS:**

```sh
cp Caddyfile.example Caddyfile              # replace surface.example.com with your domain
sed -i 's/^SURFACE_BIND=.*/SURFACE_BIND=127.0.0.1/' .env   # reachable only through Caddy
docker compose --profile proxy up -d
```

Copy the Caddyfile before the first `up`: otherwise Docker creates an empty `Caddyfile`
directory in its place.

With a proxy you already run (nginx, Traefik, another Caddy), follow
[reverse-proxy.md](docs/ops/reverse-proxy.md) instead.

With your own PostgreSQL 17+, set `DATABASE_URL` and `COMPOSE_FILE=docker-compose.external-db.yml`
in `.env` before starting. Every `docker compose` command then uses that file, which has no
bundled database.

### 5. Check

```sh
docker compose ps                         # app and db turn "healthy" within a minute
docker compose logs app | grep 'Surface is ready'
docker compose exec app surface doctor
```

`surface doctor` prints one line per check and exits non-zero if anything needs fixing. A warning
on the public URL is expected when the server can't reach its own public address, or when
`SURFACE_URL` is plain `http://`.

### 6. Open Surface

Open `SURFACE_URL` in a browser. Once workspace setup ships (PLAN-001), `docker compose logs app`
prints a one-time setup link. It opens a short wizard that creates the workspace, the first admin and the first team.

## Running Surface

| Task                                           | Guide                                                      |
| ---------------------------------------------- | ---------------------------------------------------------- |
| HTTPS with Caddy, nginx or Traefik             | [docs/ops/reverse-proxy.md](docs/ops/reverse-proxy.md)     |
| Upgrade to a new version, and roll back        | [docs/ops/upgrade.md](docs/ops/upgrade.md)                 |
| Back up and restore                            | [docs/ops/backup-manual.md](docs/ops/backup-manual.md)     |
| Startup errors, `surface doctor`, common fixes | [docs/ops/troubleshooting.md](docs/ops/troubleshooting.md) |
| Every configuration variable                   | [docker/.env.example](docker/.env.example)                 |

The `surface` command inside the container: `docker compose exec app surface <command>`.

| Command   | What it does                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------- |
| `doctor`  | Checks configuration, database, extensions, migrations, disk, SMTP and the public URL. Read-only. |
| `version` | Prints the version, commit and schema level (`--json` for scripts).                               |
| `migrate` | Applies pending migrations, then exits (they also run at startup).                                |
| `serve`   | Runs the server (the container's default command).                                                |

## Development

You need Node 24 ([nvm](https://github.com/nvm-sh/nvm): `nvm use`), pnpm 10 and Docker.

```sh
pnpm install
pnpm dev        # dev database, migrations, server and web app: open http://localhost:5173
pnpm check      # build, lint, typecheck and unit tests
```

`pnpm test:int` runs the integration tests against a throwaway PostgreSQL. Each checkout gets its
own dev database; `pnpm dev:db:down` stops it and keeps its data. `PORT`, `SURFACE_DEV_WEB_PORT`
and `SURFACE_DEV_PG_PORT` move the server, Vite and PostgreSQL to other ports.

Start with [CLAUDE.md](CLAUDE.md) for the rules of the codebase, then [docs/](docs/): the product
in `02-product`, the domain model in `03-domain`, the architecture in `04-architecture`, feature
specs in `06-specs` and the build plan in `07-plans`.
