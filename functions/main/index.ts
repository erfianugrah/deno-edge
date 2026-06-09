// MAIN RUNTIME — function dispatcher (edge-runtime `--main-service` entrypoint).
//
// Static sites are served by the deno-edge Caddy (file_server), NOT here — the
// sandboxed user runtime can't read disk anyway (Deno.stat → NotSupported). This
// runtime only dispatches functions:
//
//   /<name>/... → sandboxed user-runtime isolate at functions/<name> (mem + timeout capped)
//
// The deno-edge Caddy rewrites a function host (e.g. hello.fn.example.com) to
// /hello{uri} before proxying here, so the first path segment is the function name.

import * as jose from "npm:jose@5";

// `EdgeRuntime` is a global injected by the main runtime.
declare const EdgeRuntime: {
  userWorkers: {
    create(opts: {
      servicePath: string;
      memoryLimitMb: number;
      workerTimeoutMs: number;
      noModuleCache: boolean;
      importMapPath: string | null;
      envVars: [string, string][];
    }): Promise<{ fetch(req: Request): Promise<Response> }>;
  };
};

const FUNCTIONS_DIR = "/home/deno/functions";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const VERIFY_JWT = Deno.env.get("VERIFY_JWT") === "true";
const MEMORY_LIMIT_MB = Number(Deno.env.get("WORKER_MEMORY_MB") ?? 150);
const WORKER_TIMEOUT_MS = Number(Deno.env.get("WORKER_TIMEOUT_MS") ?? 60_000);

console.log(`main runtime started (functions only; verify_jwt=${VERIFY_JWT})`);

function getAuthToken(req: Request): string {
  const header = req.headers.get("authorization");
  if (!header) throw new Error("missing authorization header");
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new Error("authorization header must be 'Bearer <token>'");
  }
  return token;
}

async function verifyJWT(jwt: string): Promise<boolean> {
  if (!JWT_SECRET) {
    console.error("VERIFY_JWT=true but JWT_SECRET is unset — rejecting");
    return false;
  }
  try {
    await jose.jwtVerify(jwt, new TextEncoder().encode(JWT_SECRET));
    return true;
  } catch (err) {
    console.error("jwt verify failed:", err);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "OPTIONS" && VERIFY_JWT) {
    try {
      if (!(await verifyJWT(getAuthToken(req)))) {
        return Response.json({ msg: "invalid JWT" }, { status: 401 });
      }
    } catch (e) {
      return Response.json({ msg: String(e) }, { status: 401 });
    }
  }

  const { pathname } = new URL(req.url);
  const name = pathname.split("/")[1];
  if (!name) {
    return Response.json({ msg: "missing function name in path" }, { status: 400 });
  }

  const servicePath = `${FUNCTIONS_DIR}/${name}`;
  const envVars = Object.entries(Deno.env.toObject()) as [string, string][];
  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: MEMORY_LIMIT_MB,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
      noModuleCache: false,
      importMapPath: null,
      envVars,
    });
    return await worker.fetch(req);
  } catch (e) {
    // Most common cause: functions/<name>/index.ts doesn't exist.
    return Response.json({ msg: String(e) }, { status: 500 });
  }
});
