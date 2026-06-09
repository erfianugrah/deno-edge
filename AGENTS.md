# AGENTS.md — deno-edge

Self-hosted Deno Edge Functions + static-site platform. Human docs: [README.md](./README.md).
This file is the fast path for an agent working in the repo.

## Layout

```
compose.yaml              edge-runtime + caddy (two services)
Caddyfile                 app router (static = file_server, function = proxy). {$FN_ZONE} from .env
Caddyfile.snippet         front-proxy TLS blocks (two ingress options)
functions/main/index.ts   privileged dispatcher: routes /<name> to a user isolate, optional JWT gate
functions/<name>/index.ts a function (sandboxed Deno.serve handler)
sites/<name>/             static site content (gitignored — built artifacts)
examples/hello-site/      committed demo static site
.env                      config (gitignored); see .env.example
```

## Non-negotiable runtime constraints

`edge-runtime` user isolates are sandboxed. When writing or reviewing a
`functions/<name>/index.ts`:

- **No remote imports.** `npm:` / `jsr:` / `https:` are fetched at request time and
  the isolate is killed mid-load (`early termination has been triggered`) *before*
  the handler runs — the symptom is a generic `Internal Server Error`, not your
  catch block. Keep functions dependency-free (bundle/vendor if needed).
- **No disk reads.** `Deno.stat` / `Deno.readFile` on real paths → `NotSupported`.
- **Static files are served by Caddy `file_server`, never a function.** Don't add a
  function that reads from `/srv/sites` — it can't.

Only `functions/main/index.ts` (the main runtime) has full env + fs; it just
dispatches and optionally checks a JWT.

## Routing convention

`<name>.{$FN_ZONE}` →
- static site → `file_server` from `/srv/sites/<name>`
- function → `reverse_proxy edge-runtime:9000` with `rewrite * /<name>{uri}`
  (edge-runtime dispatches by the first path segment, hence the rewrite)

## Build / test

```bash
docker compose config -q                                  # validate compose
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d
curl localhost:8080 -H 'Host: hello.fn.example.com' -d '{"name":"x"}'   # function
curl localhost:8080 -H 'Host: hello-site.fn.example.com'                # static
```

## Conventions

- TLS terminates at the front proxy; this stack is plain HTTP on the published port.
- Bump `supabase/edge-runtime` / `caddy` image tags in `compose.yaml` deliberately.
- Never commit `.env` or `sites/` (both gitignored).
