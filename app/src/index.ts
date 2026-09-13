import { Container } from "@cloudflare/containers";

interface Env {
  BOOKING_APP: DurableObjectNamespace<BookingApp>;
  NEXTAUTH_SECRET: string;
  CALENDSO_ENCRYPTION_KEY: string;
  OWNER_PASSWORD: string;
  OWNER_EMAIL?: string;
  OWNER_NAME?: string;
  OWNER_USERNAME?: string;
}

const FORWARDED_SECRETS = [
  "NEXTAUTH_SECRET",
  "CALENDSO_ENCRYPTION_KEY",
  "OWNER_PASSWORD",
  "OWNER_EMAIL",
  "OWNER_NAME",
  "OWNER_USERNAME",
] as const;

export class BookingApp extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "2h";
  enableInternet = true;
  // CF polls this endpoint via HTTP to confirm the container is ready.
  // Prevents the DO from falling back to HTTPS for readiness detection.
  pingEndpoint = "/api/health";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Worker secrets (`wrangler secret put …`) are forwarded into the container
    // process as plain env vars so the Next app reads them at runtime.
    const forward: Record<string, string> = {};
    for (const key of FORWARDED_SECRETS) {
      const value = env[key];
      if (typeof value === "string" && value.length > 0) forward[key] = value;
    }
    this.envVars = forward;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Stable id — do NOT keep bumping this. With max_instances>1 (wrangler.toml)
    // a deploy rolls a fresh container in alongside the old one, so we no longer
    // need a new id per deploy (which orphaned warm instances + tripped the
    // max-instances cap).
    const container = (env.BOOKING_APP as any).getByName("booking-app-4");

    // CF docs show "http://container/path" as the URL format for container.fetch().
    // Using the literal hostname "container" routes to the container process
    // via CF's internal networking, avoiding any external HTTPS resolution.
    const url = new URL(request.url);
    const containerUrl = `http://container${url.pathname}${url.search}`;
    const containerRequest = new Request(containerUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    });

    let resp: Response;
    try {
      resp = await container.fetch(containerRequest);
    } catch (fetchErr: any) {
      const msg = fetchErr?.message ?? String(fetchErr);
      console.error("fetch threw:", msg);
      await container.start().catch((e: any) => console.error("start err:", e?.message));
      return new Response(`Container warming up (${msg})`, {
        status: 503,
        headers: { "Retry-After": "5", "Content-Type": "text/plain" },
      });
    }

    if (resp.status === 500) {
      // PEEK at the body via a CLONE — reading `resp.text()` then returning `resp`
      // returns a consumed-body Response, which makes CF throw "Worker threw
      // exception", masking EVERY real container 500 (tRPC/app errors) as a worker
      // crash. Clone keeps the original streamable. Keywords are tightened to
      // CF's container-not-ready phrases ONLY — the old "start"/"HTTPS" matched
      // ordinary app-error JSON and wrongly reported "warming up".
      let peek = "";
      try {
        peek = await resp.clone().text();
      } catch {
        // ignore — fall through and return the original response unchanged.
      }
      if (
        peek.includes("not running") ||
        peek.includes("not listening") ||
        peek.includes("no container instance") ||
        peek.includes("container is not")
      ) {
        console.error("container not ready:", peek.slice(0, 200));
        await container.start().catch((e: any) => console.error("start err:", e?.message));
        return new Response(`Container warming up: ${peek.slice(0, 100)}`, {
          status: 503,
          headers: { "Retry-After": "5", "Content-Type": "text/plain" },
        });
      }
    }

    return resp;
  },
} satisfies ExportedHandler<Env>;
