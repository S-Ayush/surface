# Reverse proxy and HTTPS

Surface speaks plain HTTP on port 3000 and expects a reverse proxy to terminate TLS (SPEC-004 §6).
Caddy is the simplest choice: it gets certificates on its own and needs one line of configuration.

## What any proxy must do

| Requirement | Why |
| --- | --- |
| Forward everything at the root path to `app:3000` (or `127.0.0.1:3000` from the host) | Surface can't be served under a sub-path such as `/surface/`. |
| Pass WebSocket upgrades on `/sync/` | Live updates. Without them the app shows "Live updates unavailable". |
| Keep upgraded connections open for an hour or more | Live updates hold one WebSocket per browser tab for as long as the tab is open. |
| Keep the `Host` header, set `X-Forwarded-Proto`, and put the client's address **last** in `X-Forwarded-For` (replacing the header or appending to it; Surface reads only the last entry) | Surface records the client address (sign-in limits will count attempts per address) and knows the request came over HTTPS. |
| Accept request bodies a little larger than `UPLOAD_MAX_MB` (25 MB by default) | File uploads, plus the form encoding around them. |
| Serve exactly the origin in `SURFACE_URL` | Sign-in checks the browser's origin against it. |

Then make the proxy the only way in. With `TRUST_PROXY=true` (the default), Surface treats
whoever connects to port 3000 as the proxy and believes the last entry of its `X-Forwarded-*`
headers, so a client that reaches port 3000 directly can claim any address.

- If the proxy runs on the same host, set `SURFACE_BIND=127.0.0.1` in `.env`.
- If it runs on another machine, set `SURFACE_BIND` to this host's private address that the proxy
  connects to. Don't rely on ufw or firewalld to close port 3000: ports Docker publishes bypass
  them. To filter anyway, use the `DOCKER-USER` iptables chain.
- Without any proxy, set `TRUST_PROXY=false`.

After any change, run `docker compose up -d` and check from your own computer:

```sh
curl -sS https://surface.example.com/readyz     # {"status":"ready",...}
```

## Caddy (recommended)

### Bundled with compose

`docker-compose.yml` has an optional `caddy` service. It obtains and renews Let's Encrypt
certificates automatically.

```sh
cp Caddyfile.example Caddyfile      # replace surface.example.com with your domain
# in .env: SURFACE_URL=https://<your domain> and SURFACE_BIND=127.0.0.1
docker compose --profile proxy up -d
```

The domain's DNS record must point at the host, and ports 80 and 443 must be reachable from the
internet for the certificate challenge. Keep `--profile proxy` on every `docker compose up` and
`pull`, or set `COMPOSE_PROFILES=proxy` in `.env` so you don't have to type it.

### Caddy on the host

```caddyfile
surface.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
```

Caddy passes WebSocket upgrades, keeps connections open as long as they are used, and sets the
forwarded headers itself, ignoring any the client sent. Nothing else is needed.

## nginx

nginx needs the WebSocket headers spelled out. The example replaces the client's
`X-Forwarded-For` with `$remote_addr`; appending with `$proxy_add_x_forwarded_for` works too,
because Surface reads only the last entry.

```nginx
# Sends "Connection: upgrade" only when the client asked for an upgrade.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name surface.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name surface.example.com;

    # For example from certbot: certbot certonly --nginx -d surface.example.com
    ssl_certificate     /etc/letsencrypt/live/surface.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/surface.example.com/privkey.pem;

    # A little above UPLOAD_MAX_MB in .env (25 by default), for the form encoding.
    client_max_body_size 26m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        # $remote_addr, not $proxy_add_x_forwarded_for: appending would keep an
        # address the client made up, and Surface would believe it.
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;

        # Generous limits for live-update WebSockets; clients reconnect if one is cut.
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

`http2 on;` needs nginx 1.25.1 or newer. On older versions, remove it and write
`listen 443 ssl http2;` instead.

## Traefik

Traefik passes WebSocket upgrades and forwarded headers without extra configuration. The example
assumes Traefik v3 already runs in its own compose project, with an entry point named `websecure`,
a certificate resolver named `letsencrypt`, and a Docker network named `traefik` that it watches.

Save this as `docker-compose.override.yml` next to `docker-compose.yml`. Compose merges it
automatically, unless `COMPOSE_FILE` is set in `.env` (as with your own PostgreSQL). Then add it
there: `COMPOSE_FILE=docker-compose.external-db.yml:docker-compose.override.yml`.

```yaml
services:
  app:
    # Reachable only through Traefik.
    ports: !reset []
    networks: [default, traefik]
    labels:
      traefik.enable: 'true'
      traefik.docker.network: traefik
      traefik.http.routers.surface.rule: Host(`surface.example.com`)
      traefik.http.routers.surface.entrypoints: websecure
      traefik.http.routers.surface.tls.certresolver: letsencrypt
      traefik.http.services.surface.loadbalancer.server.port: '3000'

networks:
  traefik:
    external: true
```

`ports: !reset []` removes the published port 3000 (Compose 2.24 or newer). On older versions,
keep the port and set `SURFACE_BIND=127.0.0.1` instead.

Traefik v3 limits reading a request to 60 seconds by default
(`entryPoints.websecure.transport.respondingTimeouts.readTimeout`). Raise it if people upload large
files over slow connections.

## Problems

See [troubleshooting](troubleshooting.md): [sign-in fails or redirects
loop](troubleshooting.md#sign-in-fails-or-the-page-loads-from-the-wrong-address) and [live updates
unavailable](troubleshooting.md#live-updates-unavailable).
