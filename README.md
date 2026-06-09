# deno-edge

Your own **Deno Edge Functions + static-site platform** — self-hosted, in two small
containers. Like a tiny Deno Deploy / Netlify / Cloudflare Pages you run yourself.

- **Functions** run on [`supabase/edge-runtime`](https://github.com/supabase/edge-runtime)
  — the same Deno-based isolate host Supabase Cloud uses for Edge Functions.
- **Static sites** are served by [Caddy](https://caddyserver.com)'s `file_server`.
- **Routing** lives in one `Caddyfile` in this repo. Adding an app is a config edit
  here — no changes to whatever reverse proxy sits in front.

```
            ┌──────────────────────────────────────────────┐
 Internet → │ your edge proxy (TLS) ──► deno-edge caddy :80 │
            └──────────────────────────────────────────────┘
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  │                                                │
          static site (file_server)                  function (reverse_proxy)
          /srv/sites/<name>                           edge-runtime :9000 → user isolate
```

## Why two runtimes (and what the sandbox can't do)

`edge-runtime` has two runtimes — understanding the split is the whole game:

| | `functions/main/index.ts` (main) | `functions/<name>/index.ts` (user) |
|---|---|---|
| privilege | full env + filesystem | **sandboxed isolate**, memory + timeout capped |
| job | dispatch `/<name>` to a user isolate | run your handler |
| `Deno.readFile` on disk | works | **`NotSupported`** |
| remote `jsr:` / `npm:` / `https:` import | works | **killed mid-load** (`early termination`) |

Two consequences baked into this template:

1. **User functions must be dependency-free** — no remote imports at request time.
   Bundle/vendor anything you need.
2. **Static files are served by Caddy**, not a function — the user isolate can't read
   disk anyway, and Caddy's `file_server` does it properly (ranges, etags, compression).

## Quick start

```bash
cp .env.example .env          # set FN_ZONE, STACK_DIR, etc.
cp -r examples/hello-site sites/hello-site   # the example static site
docker compose up -d
```

Test (the example function + site, via the published port):

```bash
curl localhost:8080 -H 'Host: hello.fn.example.com' -d '{"name":"world"}'
curl localhost:8080 -H 'Host: hello-site.fn.example.com'
```

Put a TLS-terminating reverse proxy in front (see [Ingress](#ingress--tls)) and the
apps are reachable at `https://hello.fn.example.com` / `https://hello-site.fn.example.com`.

## Add a function

```bash
mkdir functions/greet
cat > functions/greet/index.ts <<'EOF'
// no remote imports — the user runtime can't fetch them at request time
Deno.serve((req) => Response.json({ ok: true, path: new URL(req.url).pathname }));
EOF
```

Add a route to `Caddyfile`:

```caddyfile
http://greet.{$FN_ZONE} {
    rewrite * /greet{uri}        # edge-runtime routes by the first path segment
    reverse_proxy edge-runtime:9000
}
```

`docker compose restart caddy` (and `edge-runtime` if it was already running).

## Add a static site

Build your site (at **root base** — it's served at the subdomain root), drop the
output in `sites/<name>/`, and add a route:

```caddyfile
http://blog.{$FN_ZONE} {
    root * /srv/sites/blog
    encode zstd gzip
    file_server
}
```

## Ingress / TLS

`deno-edge` itself speaks **plain HTTP** — terminate TLS at a proxy in front. Two
patterns (see [`Caddyfile.snippet`](./Caddyfile.snippet) for copy-paste blocks):

- **Wildcard + listed domains** — one wildcard cert for `*.fn.example.com` (apps =
  zero proxy changes) plus one line per custom domain. Works everywhere, including
  when your proxy already has a global default cert issuer.
- **On-demand TLS** — a single catch-all that issues a cert for *any* hostname
  deno-edge serves, gated by the `/_caddy/ask` endpoint in `Caddyfile` (so random
  hosts pointed at you can't mint certs). True zero-config custom domains, but the
  catch-all conflicts with a global default issuer — use it on a proxy without one.

## Configuration

All via `.env` (see `.env.example`):

| var | meaning |
|---|---|
| `FN_ZONE` | base zone for app subdomains, e.g. `fn.example.com` |
| `STACK_DIR` | where this repo lives on the Docker host (`.` for vanilla compose; an absolute path if your orchestrator runs compose from a different cwd) |
| `HTTP_PORT` / `BIND_ADDR` | host port the internal Caddy is published on |
| `VERIFY_JWT` / `JWT_SECRET` | optional HS256 gate on functions (in `functions/main`) |
| `WORKER_MEMORY_MB` / `WORKER_TIMEOUT_MS` | per-invocation user-isolate limits |

## Caveats

- Self-hosted Edge Functions are **beta** upstream — flags/behaviour may change.
- Single node — no global distribution. Great for a homelab / learning the runtime.
- Bump images: check `supabase/edge-runtime` and `caddy` tags, edit `compose.yaml`.

## License

MIT — see [LICENSE](./LICENSE).
