# Roadmap

Where `deno-edge` is and where it's going. Status: `✅ done` · `🚧 in progress` · `📋 planned`.

## Now — shipped

- ✅ **Functions** on `supabase/edge-runtime` (sandboxed Deno isolates, memory + timeout capped)
- ✅ **Static sites** via Caddy `file_server`
- ✅ **Host-based routing** — one `Caddyfile`, app config in the repo
- ✅ **TLS** — wildcard (`*.fn.<zone>`) + custom domains; on-demand option
- ✅ **Optional JWT gate** on functions

## Milestone 1 — Build & deploy pipeline 📋

The spine. Turns "rsync files + restart" into a real deploy flow, and unblocks
dependencies in functions.

- 📋 **Build step** — `git push` runs your build in an ephemeral container
- 📋 **Function bundling** (eszip) — inlines `npm:` / `jsr:` / `https:` deps, so functions
  can finally use dependencies (today the sandbox can't fetch them at request time)
- 📋 **Immutable releases** — `releases/<app>/<sha>/`, write-once
- 📋 **Atomic deploy + instant rollback** — flip a manifest, no rebuild
- 📋 **Preview URLs** — `<sha>.preview.<zone>` per build
- 📋 **Deployer service** — webhook receiver, build orchestrator, promote/rollback API + UI

## Milestone 2 — Observability 📋

- 📋 **Structured per-invocation logs** — JSON with app / function / request id / status / duration
- 📋 **Request correlation** — `X-Request-Id` from Caddy through to user functions
- 📋 **Log shipping** — to a configurable sink (e.g. Loki), integrate an existing stack or bundle one
- 📋 **Dashboard** — requests/min, p50/p95 latency, error rate, live tail

## Milestone 3 — Storage bindings 📋

Ergonomic, pre-wired access to state — feeling like KV / Blobs / D1. Depends on M1's
bundle step (the client libraries ride it).

- 📋 **`blob`** — object storage (S3-compatible)
- 📋 **`db`** — SQL
- 📋 **`kv`** — key/value with TTL
- 📋 **Bindings SDK** — `import { blob, db, kv } from "deno-edge/bindings"`, env-driven, per-app scoped

## Out of scope (by design)

`deno-edge` is a **single-node** platform. It deliberately does not try to be a global edge:

- ❌ Global CDN / multi-region — run a CDN (e.g. Cloudflare) in front, or host global
  workloads on a platform built for it
- ❌ Anycast / automatic failover
- ❌ Multi-tenant teams / org RBAC

It wins on control, cost, no lock-in, and running the real runtime yourself — not on
latency-to-every-user.

---

Detailed design for M1–M3 lives in [`docs/plans/`](./docs/plans/).
