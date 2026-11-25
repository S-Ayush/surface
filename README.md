<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/05-design/brand/assets/surface-lockup-dark.svg">
    <img src="docs/05-design/brand/assets/surface-lockup.svg" alt="Surface" height="48">
  </picture>
</p>

<p align="center"><strong>The only open-source issue tracker your team needs.</strong></p>

Surface is a self-hosted, keyboard-first issue tracker for small teams (10 to 50 people), with
Linear's model: teams, workflows, cycles, projects and views. One install serves one company: a
Docker image plus PostgreSQL on a machine you own. The client keeps a replica of the workspace
metadata, so lists, boards, filters and search work without a round-trip to the server.

Surface makes no outbound network calls except to your own SMTP server. That rules out telemetry,
update checks, CDNs and external fonts. There is no commercial edition and no multi-tenancy.

> **Status: early development.** The install path below works: the image, configuration checks,
> migrations, health checks, the `surface` CLI and first-run setup. There is no published image
> yet, so step 2 builds it from source.

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
- without a proxy, on a trusted network: `http://<server address>:3000`. Over plain http, browsers
  don't let the app reload while offline or while the server is down, and a few smaller things need
  HTTPS too (SPEC-004 E9).

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

On first start, Surface logs a one-time setup link. Find it with:

```bash
docker compose logs app | grep setupUrl
```

The line reads `Surface is not set up yet. Open https://surface.example.com/setup?token=XXXX-XXXX-… to create the workspace and the first Admin.` Open that link. A short wizard creates the workspace, your Admin account and the first team, then signs you in. Until setup is done, every other page leads to the wizard.

The link changes each time the server restarts. If you run more than one app container, set `SURFACE_SETUP_TOKEN` so that every logged link works. The link is logged as a warning, so it doesn't appear with `LOG_LEVEL=error`. If you lost it, print a new one:

```bash
docker compose exec app surface setup-token
```

## Running Surface

| Task                                           | Guide                                                      |
| ---------------------------------------------- | ---------------------------------------------------------- |
| HTTPS with Caddy, nginx or Traefik             | [docs/ops/reverse-proxy.md](docs/ops/reverse-proxy.md)     |
| Upgrade to a new version, and roll back        | [docs/ops/upgrade.md](docs/ops/upgrade.md)                 |
| Back up and restore                            | [docs/ops/backup-manual.md](docs/ops/backup-manual.md)     |
| Startup errors, `surface doctor`, common fixes | [docs/ops/troubleshooting.md](docs/ops/troubleshooting.md) |
| Every configuration variable                   | [docker/.env.example](docker/.env.example)                 |

The `surface` command inside the container: `docker compose exec app surface <command>`.

| Command   | What it does                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `doctor`  | Checks configuration, database, collations, extensions, migrations, disk, SMTP and the public URL. Read-only. |
| `version` | Prints the version, commit and schema level (`--json` for scripts).                                           |
| `migrate` | Applies pending migrations, then exits (they also run at startup).                                            |
| `serve`   | Runs the server (the container's default command).                                                            |

## Development

You need Node 24 ([nvm](https://github.com/nvm-sh/nvm): `nvm use`), pnpm 10 and Docker (Colima
works on macOS). Docker is only needed for the integration tests and the dev database.

```sh
pnpm install
pnpm dev        # dev database, migrations, server and web app: open http://localhost:5173
pnpm check      # build, lint, typecheck, licence check and unit tests
```

`pnpm test:int` runs the integration tests against a throwaway PostgreSQL. Each checkout gets its
own dev database; `pnpm dev:db:down` stops it and keeps its data. `PORT`, `SURFACE_DEV_WEB_PORT`
and `SURFACE_DEV_PG_PORT` move the server, Vite and PostgreSQL to other ports. Two dev stacks on
one machine share cookies, because browsers keep cookies per host, not per port: signing in on one
signs you out of the other. Give each stack its own loopback name, such as
`SURFACE_URL=http://a.localhost:5173 pnpm dev`, and open that address (every `*.localhost` name is
this machine).

## Documentation map

| Folder                                        | What is in it                                      |
| --------------------------------------------- | -------------------------------------------------- |
| [docs/01-vision](docs/01-vision/VISION.md)    | Why Surface exists, its principles and non-goals   |
| [docs/02-product](docs/02-product/PRD.md)     | What Surface 1.0 must do (the PRD)                 |
| [docs/03-domain](docs/03-domain/)             | Entities, invariants, state machines, permissions  |
| [docs/04-architecture](docs/04-architecture/) | Architecture, sync protocol and decision records   |
| [docs/05-design](docs/05-design/)             | Design tokens, components, shortcuts, brand        |
| [docs/06-specs](docs/06-specs/)               | Feature specs with acceptance criteria             |
| [docs/07-plans](docs/07-plans/README.md)      | Build order and slice plans                        |
| [docs/ops](docs/ops/)                         | Reverse proxy, upgrade, backup and troubleshooting |

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities
privately, as [SECURITY.md](SECURITY.md) describes. Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

## Licence

Surface is released under the [MIT licence](LICENSE) ([ADR-0026](docs/04-architecture/adr/0026-open-source-mit.md)).
