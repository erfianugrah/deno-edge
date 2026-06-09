// USER RUNTIME — runs in a sandboxed isolate with the memory/timeout limits
// set by functions/main/index.ts. Plain Deno.serve handler.
//
// IMPORTANT: keep user functions DEPENDENCY-FREE. The user isolate can't fetch
// remote modules (npm:/jsr:/https:) at request time — it gets killed mid-load
// ("early termination") before your handler runs. Bundle/vendor anything you need.
// (It also can't read disk: Deno.readFile -> NotSupported. Serve files via Caddy.)

Deno.serve(async (req: Request) => {
  let name = "world";
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await req.json();
      if (typeof body?.name === "string") name = body.name;
    } catch {
      // ignore malformed JSON, fall back to default
    }
  }

  return Response.json({
    message: `hello, ${name}`,
    runtime: "supabase/edge-runtime",
    deno: Deno.version.deno,
    at: new Date().toISOString(),
  });
});
