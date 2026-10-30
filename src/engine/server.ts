import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Twin, type ChaosConfig, type ChaosMode, ALL_CHAOS } from "./twin.js";
import type { TwinDefinition } from "./types.js";
import { isLocalHost, isLocalOrigin } from "../lib/localOnly.js";
import { dashboardHtml } from "../dashboard/page.js";
import { checkoutPage, donePage } from "../dashboard/checkout.js";
import { readState, writeState } from "./state.js";

export interface ServeOptions {
  port?: number;
  chaos?: ChaosConfig | null;
  webhookUrls?: string[];
  allowWebhookHosts?: string[];
  /** Extra browser origins allowed to call the twin (localhost origins are always allowed). */
  corsOrigins?: string[];
  webhookSecret?: string;
  timeoutMs?: number;
  autoScale?: number;
  /** Keep the twin's objects in this file: loaded at start, saved after changes and on close. */
  statePath?: string;
}

export interface RunningTwin {
  twin: Twin;
  url: string;
  port: number;
  token: string;
  dashboardUrl: string;
  /** Set when state is saved to a file. */
  state?: { path: string; restored: number; dropped: number; savedAt?: string };
  close(): Promise<void>;
}

const CONTROL = "/__mockanything";
const MAX_BODY = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(value), { "content-type": "application/json", "cache-control": "no-store", ...headers });
}

function htmlHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self' http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'`,
  };
}

const MODES = new Set<string>(ALL_CHAOS);

export async function serveTwin(def: TwinDefinition, opts: ServeOptions = {}): Promise<RunningTwin> {
  const token = randomBytes(18).toString("base64url");
  const corsOrigins = new Set((opts.corsOrigins ?? []).map((o) => o.replace(/\/$/, "").toLowerCase()));
  let twin!: Twin;
  const sse = new Set<ServerResponse>();

  const originAllowed = (origin: string | undefined) => !origin || isLocalOrigin(origin) || corsOrigins.has(origin.toLowerCase());

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (!isLocalHost(host)) return sendJson(res, 421, { error: "Mock Anything only answers requests addressed to localhost." });
      const url = new URL(req.url ?? "/", "http://localhost");
      const origin = req.headers.origin;

      if (url.pathname === "/favicon.ico") return send(res, 204, "", { "cache-control": "max-age=86400" });
      if (url.pathname === CONTROL || url.pathname.startsWith(`${CONTROL}/`)) {
        return await control(req, res, url, origin);
      }

      // the twin API
      if (!originAllowed(origin)) return sendJson(res, 403, { error: "Origin not allowed. Add it with --cors <origin>." });
      const cors: Record<string, string> = origin ? {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-expose-headers": "*",
        vary: "Origin",
      } : {};
      if (req.method === "OPTIONS") {
        return send(res, 204, "", {
          ...cors,
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "*"),
          "access-control-max-age": "600",
        });
      }
      const rawBody = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      const r = await twin.handle({ method: req.method ?? "GET", path: url.pathname, rawQuery: url.search.slice(1), headers, rawBody });
      if (r.delayMs) {
        await new Promise<void>((done) => {
          const t = setTimeout(done, r.delayMs);
          res.on("close", () => { clearTimeout(t); done(); });
        });
      }
      send(res, r.status, req.method === "HEAD" ? "" : (r.body ?? ""), { ...r.headers, ...cors });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      sendJson(res, status, { error: status === 413 ? "Request body too large" : "Mock Anything internal error" });
    }
  });

  async function control(req: IncomingMessage, res: ServerResponse, url: URL, origin: string | undefined): Promise<void> {
    const p = url.pathname.slice(CONTROL.length) || "/";
    const nonce = randomBytes(12).toString("base64");

    // neutral hosted test page (checkout / 3-D Secure / OTP style flows)
    const ck = p.match(/^\/checkout\/([^/]+)\/([^/]+?)(?:\/(succeed|fail))?$/);
    if (ck) {
      const [, resource, id, action] = ck.map((x) => (x ? decodeURIComponent(x) : x)) as [string, string, string, string | undefined];
      if (req.method === "GET" && !action) {
        const info = twin.checkoutInfo(resource, id, url.searchParams.get("nonce") ?? "");
        if (!info) return send(res, 404, donePage(nonce, "Link expired", "This test page has expired or the link is wrong.", undefined), htmlHeaders(nonce));
        return send(res, 200, checkoutPage(nonce, {
          title: info.title, amount: info.amount, twinTitle: twin.def.title,
          action: `${CONTROL}/checkout/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`,
          nonce: String(info.obj.__nonce), canFail: info.canFail,
        }), htmlHeaders(nonce));
      }
      if (req.method === "POST" && action) {
        if (origin && !isLocalOrigin(origin)) return sendJson(res, 403, { error: "Origin not allowed" });
        const form = new URLSearchParams(await readBody(req));
        const r = twin.checkoutAction(resource, id, form.get("nonce") ?? "", action as "succeed" | "fail");
        if (r.ok && r.returnUrl) return send(res, 303, "", { location: r.returnUrl });
        return send(res, r.ok ? 200 : 400, donePage(nonce, r.ok ? "Done" : "Not completed", r.message, undefined), htmlHeaders(nonce));
      }
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    if (p === "/" && req.method === "GET") return send(res, 200, dashboardHtml(nonce), htmlHeaders(nonce));

    // control API: token + local origin
    if (!p.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
    if (!isLocalOrigin(origin)) return sendJson(res, 403, { error: "Origin not allowed" });
    const given = req.headers["x-mockanything-token"] ?? url.searchParams.get("token");
    if (given !== token) return sendJson(res, 401, { error: "Missing or wrong control token (printed when the twin started)." });

    const body = req.method === "POST" ? safeParse(await readBody(req)) : {};
    switch (`${req.method} ${p}`) {
      case "GET /api/info": return sendJson(res, 200, info());
      case "GET /api/state": return sendJson(res, 200, twin.snapshot());
      case "GET /api/requests": return sendJson(res, 200, twin.requests.slice(-200));
      case "GET /api/deliveries": return sendJson(res, 200, twin.deliveries.slice(-200));
      case "GET /api/stream": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        sse.add(res);
        res.on("close", () => sse.delete(res));
        return;
      }
      case "POST /api/reset": twin.reset(); return sendJson(res, 200, { ok: true });
      case "POST /api/scenario": {
        try { twin.forceScenario(String(body.name ?? ""), Math.max(1, Math.min(100, Number(body.times ?? 1) || 1))); }
        catch (e) { return sendJson(res, 400, { error: (e as Error).message }); }
        return sendJson(res, 200, { ok: true });
      }
      case "POST /api/chaos": {
        const c = parseChaos(body);
        twin.setChaos(c);
        return sendJson(res, 200, { ok: true, chaos: c });
      }
      case "POST /api/clock": return sendJson(res, 200, { ok: true, nowMs: twin.advanceClock(Number(body.advanceMs ?? 0) || 0) });
      case "POST /api/webhooks": {
        try { const ep = twin.addEndpoint(String(body.url ?? ""), Array.isArray(body.events) ? body.events.map(String) : ["*"]); return sendJson(res, 200, { ok: true, id: ep.id }); }
        catch (e) { return sendJson(res, 400, { error: (e as Error).message }); }
      }
      case "POST /api/emit": {
        await twin.emitManual(String(body.type ?? ""), body.resource ? String(body.resource) : undefined, body.id ? String(body.id) : undefined);
        return sendJson(res, 200, { ok: true });
      }
      default: return sendJson(res, 404, { error: "Not found" });
    }
  }

  function info() {
    return {
      id: twin.def.id, title: twin.def.title, description: twin.def.description, source: twin.def.source, inferred: !!twin.def.inferred,
      baseUrl: running.url + (twin.def.basePath ?? ""), webhookSecret: twin.webhookSecret, endpoints: twin.listEndpoints(), scenarios: twin.scenarioNames(),
      chaos: twin.chaos, warnings: twin.warnings, notes: twin.def.notes ?? [], state: running.state ?? null,
      resources: Object.keys(twin.def.resources), operations: twin.def.operations.map((o) => `${o.method.toUpperCase()} ${twin.def.basePath ?? ""}${o.path}`),
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4010, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://localhost:${port}`;
  let saved: ReturnType<typeof readState> = null;
  try { saved = opts.statePath ? readState(opts.statePath) : null; }
  catch (e) { await new Promise<void>((r) => server.close(() => r())); throw e; }
  twin = new Twin(def, {
    baseUrl: url, chaos: opts.chaos ?? null, webhookUrls: opts.webhookUrls, allowWebhookHosts: opts.allowWebhookHosts,
    webhookSecret: opts.webhookSecret ?? saved?.webhookSecret, timeoutMs: opts.timeoutMs, autoScale: opts.autoScale,
  });
  let stateInfo: RunningTwin["state"];
  let saveTimer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(saveTimer); saveTimer = undefined;
    if (!opts.statePath) return;
    try { const s = twin.exportState(); writeState(opts.statePath, s); if (stateInfo) stateInfo.savedAt = s.savedAt; }
    catch (e) { if (!twin.warnings.includes(`state: ${(e as Error).message}`)) twin.warnings.push(`state: ${(e as Error).message}`); }
  };
  if (opts.statePath) {
    stateInfo = { path: opts.statePath, restored: 0, dropped: 0 };
    if (saved) {
      try { const r = twin.importState(saved); stateInfo.restored = r.objects; stateInfo.dropped = r.dropped; }
      catch (e) { twin.close(); await new Promise<void>((r) => server.close(() => r())); throw e; }
    }
  }
  const unsub = twin.onChange((kind, data) => {
    const line = `event: ${kind}\ndata: ${JSON.stringify(kind === "state" ? null : data)}\n\n`;
    for (const s of sse) s.write(line);
    if (opts.statePath && !saveTimer) saveTimer = setTimeout(save, 250);
  });
  const running: RunningTwin = {
    twin, url, port, token,
    dashboardUrl: `${url}${CONTROL}/#token=${token}`,
    state: stateInfo,
    close: async () => {
      unsub();
      if (opts.statePath) save();
      twin.close();
      for (const s of sse) s.end();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  return running;
}

function safeParse(s: string): Record<string, unknown> {
  try { const v = JSON.parse(s, (k, v) => (k === "__proto__" || k === "constructor" ? undefined : v)); return v && typeof v === "object" ? v : {}; }
  catch { return {}; }
}

export function parseChaos(body: Record<string, unknown> | null | undefined): ChaosConfig | null {
  if (!body || body.off || body.modes === null) return null;
  const modes = (Array.isArray(body.modes) ? body.modes : String(body.modes ?? "").split(",")).map((m) => String(m).trim()).filter((m) => MODES.has(m)) as ChaosMode[];
  const rate = Math.max(0, Math.min(1, Number(body.rate ?? 0.15)));
  const seed = Number(body.seed ?? Date.now()) >>> 0;
  return { modes: modes.length ? modes : [...ALL_CHAOS], rate: Number.isFinite(rate) ? rate : 0.15, seed };
}
