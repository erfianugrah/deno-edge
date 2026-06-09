# Plan: build pipeline, storage bindings, function logs

Status: draft · 2026-06-09

Closes three gaps vs Deno Deploy / Netlify / CF Pages:

1. **Build + atomic-deploy + preview pipeline** (git push → build → bundle → immutable release → preview URL + rollback)
3. **Storage bindings** (MinIO / Postgres / Valkey surfaced to functions as `blob` / `db` / `kv`)
4. **Function logs** (structured edge-runtime logs → sink → dashboard)

## Sequencing (why this order)

```
F1 build+bundle+release ──┬──► F3 bindings   (client libs need the bundle step)
                          └──► F4 logs       (logs key off release/app/request ids)
```

F1 is the spine. It introduces three things the others depend on:
- a **bundle step** → functions can finally use `npm:`/`jsr:` deps (today they die on
  remote-import-at-request-time). F3's S3/Postgres/redis clients ride this.
- **immutable releases** keyed by `<app>/<sha>` → stable identifiers F4 logs against.
- a **control plane** (the deployer) that already owns webhooks + Caddy reloads, which
  F3 (binding env injection) and F4 (log routing) extend.

Build F1 to the point of "prod deploys + rollback" before starting F3/F4; previews
and the UI can lag.

---

## Feature 1 — build + atomic-deploy + preview pipeline

### Goal

`git push` (or API call) → build static + bundle functions → write an immutable
`releases/<app>/<sha>/` → atomically flip prod → app live. Each non-prod build gets a
`<sha>.preview.<zone>` URL. Rollback = repoint at a previous release.

### New components

| Component | What | Where |
|---|---|---|
| **deployer** | small Deno HTTP service: webhook receiver, build orchestrator, release store, route manifest writer, Caddy admin reloader, promote/rollback API + tiny UI | `deployer/` (new container) |
| **release store** | `releases/<app>/<sha>/{site/, functions/}` on a volume | `${STACK_DIR}/releases` |
| **route manifest** | `routes.json` — source of truth mapping host → app → release | `${STACK_DIR}/state/routes.json` |
| **build runner** | ephemeral container per build (bun/node/deno toolchain) | invoked by deployer |

### Data model — `routes.json`

```jsonc
{
  "apps": {
    "blog": {
      "type": "static",
      "prod": "a1b2c3d",                       // current release sha
      "domains": ["blog.fn.example.com", "blog.example.com"],
      "history": ["a1b2c3d", "9f8e7d6", ...]   // for rollback
    },
    "api": { "type": "function", "prod": "...", "domains": ["api.fn.example.com"] }
  },
  "previews": {
    "9f8e7d6": { "app": "blog", "type": "static" }   // → 9f8e7d6.preview.fn.example.com
  }
}
```

### Build & bundle

Per app, driven by an `deno-edge.json` (or `[deno-edge]` in the repo) declaring
`type` (static|function), `build` cmd, `output` dir, function entrypoints:

- **static**: run the declared build (`bun run build` / `npm run build`) in the build
  container → copy `output/` → `releases/<app>/<sha>/site/`.
- **function**: bundle each entry with **eszip** (`supabase/eszip`, the format
  edge-runtime loads natively) → `releases/<app>/<sha>/functions/<name>.eszip`.
  This inlines `npm:`/`jsr:`/`https:` deps → **fixes the dependency-free constraint.**
  - Fallback if eszip is awkward: `esbuild` + `esbuild_deno_loader` → single ESM file.
  - Decision: eszip primary (native), esbuild fallback. Spike both in 1a.

### Atomic release + rollback

- `releases/<app>/<sha>/` is write-once; never mutated after build.
- Promote = `routes.json.apps.<app>.prod = <sha>` + reload (single JSON write, atomic
  via write-temp-rename). No symlink races; the manifest is the switch.
- Rollback = set `prod` to a `history[]` sha + reload. Instant (no rebuild).

### Release-aware routing

The deployer **generates** the edge config from `routes.json` (the platform owns it now;
no hand-edited Caddyfile for apps):

- **static** → generated Caddy snippet: per app+domain, `root * /srv/releases/<app>/{prod-sha}/site`.
  Preview hosts (`<sha>.preview.<zone>`) → `root * /srv/releases/<*>/<sha>/site`.
  Deployer writes `Caddyfile.apps` (imported by `Caddyfile`) + `POST` Caddy admin reload.
- **function** → `main/index.ts` becomes manifest-aware: read `routes.json` (mounted),
  resolve Host → app → `prod` (or preview sha from `*.preview.*` host) → `servicePath =
  /srv/releases/<app>/<sha>/functions/<name>.eszip`. edge-runtime loads the eszip.
  - main caches the manifest; deployer bumps an mtime/etag to invalidate.

### Preview URLs

- Reserve `*.preview.<zone>` (wildcard DNS + cert — already proven pattern).
- Each build registers `previews[<sha>]`; host `<sha>.preview.<zone>` serves that release.
- GC: prune preview releases older than N days / keep last M per app (deployer cron).

### Webhook + UI

- `POST /hooks/<app>` (HMAC-validated; Gitea/GitHub) → enqueue build at the pushed sha.
- Tiny utilitarian UI (`/`): apps table, releases per app, **Promote** / **Rollback**
  buttons, build log tail (SSE). Matches the design-utilitarian ethos (table, no fluff).
- Status: optional GitHub deploy status + PR comment with the preview URL (gh API).

### Phases & verification

| Phase | Deliverable | Verify |
|---|---|---|
| 1a | build runner + eszip/esbuild spike; build one static + one function app → `releases/<app>/<sha>/` | a function with an `npm:` dep returns 200 (no early-termination) |
| 1b | manifest-driven routing (prod only): generated Caddy snippet + manifest-aware `main` | `curl https://api.fn.zone` hits the bundled release |
| 1c | promote/rollback API; `routes.json` switch + reload | rollback flips response to old release in <1s, no rebuild |
| 1d | `*.preview.<zone>` per-sha serving | `curl https://<sha>.preview.fn.zone` serves that build |
| 1e | webhook trigger + control UI + preview GC | `git push` → app live; old previews pruned |

### Decisions to confirm

- Deployer language: **Deno** (consistent with the platform) vs Go. → propose Deno.
- Caddy app config: **deployer-generated** (`Caddyfile.apps`, admin-reload) — confirm we
  move app routing out of the hand-edited `Caddyfile`.
- Build isolation: ephemeral build container per deploy (clean, needs Docker socket) vs
  a fixed build service. → ephemeral.

---

## Feature 3 — storage bindings (blob / db / kv)

### Goal

Functions get ergonomic, pre-wired access to object storage, SQL, and KV — feeling like
R2/Blobs, D1, and Deno KV — without per-function boilerplate.

### Hard prerequisite spike (do first)

The user isolate blocks remote-import-at-request-time AND `Deno.readFile`. **Open
question: does it allow runtime `Deno.connect` (raw TCP)?** Supabase's own edge functions
talk to Postgres over TCP, which suggests yes — but verify on *our* edge-runtime build:

- Spike: a bundled function that does `Deno.connect` to Postgres + a redis `PING`.
- If TCP works → use native drivers (postgres-js, a redis client), bundled via F1.
- If TCP is `NotSupported` → front each backend with HTTP (PostgREST for PG, webdis/HTTP
  shim for Valkey; MinIO is already HTTP) and use `fetch`. Decision gate.

### Backends (the user already runs all three)

| Binding | Backend | Access |
|---|---|---|
| `blob` | **MinIO** | S3 HTTP + SigV4 via `fetch` (sandbox-safe regardless of TCP outcome) |
| `db` | **Postgres** | native driver over TCP *or* PostgREST HTTP (per spike) |
| `kv` | **Valkey** | native redis client over TCP *or* a small HTTP proxy (per spike) |

### Bindings SDK

Ship `_shared/bindings.ts` (bundled into functions by F1) exposing:

```ts
import { blob, db, kv } from "deno-edge/bindings";   // resolved from injected env
await blob.put("avatars/x.png", bytes);
const rows = await db.query`select * from todos where id = ${id}`;
await kv.set(["session", id], data, { ttlMs: 3600_000 });
```

- Reads connection info from env (below). Lazy-inits clients, memoised per isolate.
- Per-app scoping: prefix blob keys + KV namespaces by app; optional per-app DB role.

### Env injection

The deployer injects per-app binding env into the release (consumed by `main` →
forwarded to the isolate). Secrets come from the platform secret store (not committed):

```
BLOB_ENDPOINT, BLOB_BUCKET, BLOB_KEY, BLOB_SECRET
DATABASE_URL            # or PGRST_URL if HTTP path
KV_URL                  # or KV_HTTP_URL
```

### Phases & verification

| Phase | Deliverable | Verify |
|---|---|---|
| 3a | TCP-vs-HTTP spike → driver decision | bundled fn reads a row from Postgres + KV PING |
| 3b | `blob` (MinIO S3) + SDK + env injection | fn uploads + signed-URL downloads an object |
| 3c | `db` + `kv` per the spike decision | fn round-trips a row + a KV ttl key |
| 3d | per-app scoping (key prefix / namespace / role) | app A can't read app B's blob/kv |

### Decisions to confirm

- TCP drivers vs HTTP gateways (gated by 3a spike).
- Whether to stand up PostgREST/webdis (HTTP path) or rely on TCP drivers.
- Per-app DB isolation: shared DB + RLS/role-per-app vs DB-per-app.

---

## Feature 4 — function logs (structured → sink → dashboard)

### Goal

Per-invocation structured logs, queryable, with a dashboard. Today: only `docker logs`.

### Structured logging in `main/index.ts`

Wrap dispatch to emit one JSON line per request:

```json
{"ts":"...","app":"api","fn":"hello","host":"api.fn.example.com","req_id":"...",
 "status":200,"dur_ms":12,"isolate":"...","release":"a1b2c3d"}
```

- `req_id`: inject `X-Request-Id` at deno-edge Caddy (it already supports this); `main`
  reads + logs it; user functions can read it for correlation.
- Capture user `console.*` too (edge-runtime forwards isolate stdout) — tag with req_id.

### Pipeline

- **Vector** (or Promtail) sidecar in the deno-edge compose: tails edge-runtime + caddy
  container logs → ships to **Loki**.
- Make the Loki endpoint configurable (`LOKI_URL`) so it **integrates an existing Loki/
  Grafana** if present, else the template ships a minimal Loki+Grafana.

### Dashboard

- Default: **Grafana** dashboard (Loki datasource) — requests/min, p50/p95 latency,
  error rate, per-app/per-fn filters, live tail.
- Optional: a small custom `/logs` view in the deployer UI (matches wafctl-style
  utilitarian dashboards) reading Loki's HTTP query API. Decide after Grafana baseline.

### Phases & verification

| Phase | Deliverable | Verify |
|---|---|---|
| 4a | structured JSON access log in `main` + `X-Request-Id` from Caddy | log line per request with req_id + dur_ms |
| 4b | Vector → Loki pipeline (configurable endpoint) | a request shows up in Loki within seconds |
| 4c | Grafana dashboard (rps / latency / errors / live tail) | filter by app+fn, see p95 |
| 4d | (optional) `/logs` tail in deployer UI | live tail in-app |

### Decisions to confirm

- Ship Loki+Grafana in the template vs require an external `LOKI_URL`. → configurable,
  default to external if set.
- Custom `/logs` view vs Grafana-only.

---

## Milestones

- **M1 (F1 core):** 1a–1c — push/build/bundle, immutable releases, prod deploy + instant
  rollback. The platform becomes "real." Unblocks F3.
- **M2 (observability):** 4a–4c — structured logs + Loki + Grafana. Independent of M1
  internals; can run alongside.
- **M3 (bindings):** 3a–3d — after M1 (needs the bundle step).
- **M4 (polish):** 1d–1e previews + UI + webhooks; 4d custom log view.

## Open decisions (please confirm before M1)

1. Deployer in **Deno** (proposed) vs Go.
2. App routing moves to **deployer-generated** Caddy config (out of the hand-edited
   `Caddyfile`) — OK?
3. Build = **ephemeral per-deploy container** with Docker socket — OK in your threat model?
4. Logs: **integrate your existing Loki/Grafana** if present, else bundle minimal — OK?
5. Bindings driver path decided by the 3a TCP spike — proceed spike-first?
