import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDocument } from "../src/engine/load.js";
import { ingestOpenApi } from "../src/ingest/openapi.js";
import { serveTwin, type RunningTwin } from "../src/engine/server.js";
import { validateDefinition } from "../src/engine/schema.js";
import { evalExpr, render } from "../src/engine/template.js";
import { parseForm, findRealCard, maskHeaders, safeJsonParse } from "../src/engine/util.js";
import { discoverSpecLink } from "../src/ingest/resolve.js";
import { Twin } from "../src/engine/twin.js";
import type { TwinDefinition } from "../src/engine/types.js";

const shop = () => ingestOpenApi(parseDocument(readFileSync(new URL("./fixtures/shop.openapi.yaml", import.meta.url), "utf8")), "shop.openapi.yaml");

describe("template and parsing safety", () => {
  it("never reaches prototypes or unknown functions", () => {
    const ctx = { body: { a: 1 }, fns: { ok: () => "fn" } };
    expect(evalExpr("body.__proto__", ctx)).toBeUndefined();
    expect(evalExpr("body.constructor", ctx)).toBeUndefined();
    expect(evalExpr("process.env", ctx)).toBeUndefined();
    expect(evalExpr("eval('1')", ctx)).toBeUndefined();
    expect(evalExpr("toString()", ctx)).toBeUndefined();
    expect(evalExpr("ok()", ctx)).toBe("fn");
    expect(render({ x: "{{body.a ?? 2}}", y: "n={{body.a}}" }, ctx)).toEqual({ x: 1, y: "n=1" });
  });
  it("parses Stripe-style nested forms without polluting prototypes", () => {
    const f = parseForm("metadata[a]=1&items[0][price]=p&items[1][price]=q&expand[]=x&expand[]=y&__proto__[polluted]=1&a[constructor][prototype][z]=1");
    expect(f).toEqual({ metadata: { a: "1" }, items: [{ price: "p" }, { price: "q" }], expand: ["x", "y"] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const j = safeJsonParse('{"__proto__":{"polluted":1},"ok":1}') as Record<string, unknown>;
    expect(j.ok).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("spots real-looking card numbers only in card fields and masks secrets", () => {
    expect(findRealCard({ card: { number: "4539148803436467" } })).toBe("4539148803436467");
    expect(findRealCard({ card: { number: "4242424242424242" } })).toBeNull();
    expect(findRealCard({ user_id: "4539148803436467" })).toBeNull();
    expect(maskHeaders({ authorization: "Bearer sk_test_abcdefgh12345678" }).authorization).toBe("Bearer sk_test_…5678");
  });
});

describe("definition validation", () => {
  it("rejects unknown keys, bad references and oversized input", () => {
    expect(() => validateDefinition({ schema: 1, id: "x", title: "X", auth: { type: "none" }, resources: {}, operations: [{ method: "GET", path: "/a", action: "read", resource: "nope" }] })).toThrow(/unknown resource/);
    expect(() => validateDefinition({ schema: 1, id: "x", title: "X", auth: { type: "none" }, resources: {}, operations: [], exec: "rm -rf /" })).toThrow(/Invalid twin definition/);
    expect(() => validateDefinition({ schema: 1, id: "../etc", title: "X", auth: { type: "none" }, resources: {}, operations: [] })).toThrow();
    expect(() => validateDefinition({ schema: 1, id: "x", title: "X", auth: { type: "none" }, resources: { a: {} }, operations: [{ method: "GET", path: "nope", action: "list", resource: "a" }] })).toThrow();
  });
});

describe("OpenAPI inference", () => {
  it("finds resources, ids, lifecycles, envelopes, scope, auth and webhooks", () => {
    const { def, report } = shop();
    expect(def.basePath).toBe("/v2");
    expect(def.auth).toMatchObject({ type: "header", name: "X-Shop-Key", optional: true });
    expect(def.resources.orders?.id).toMatchObject({ style: "prefixed", prefix: "ord_", length: 12 });
    expect(def.resources.orders?.lifecycle?.initial).toBe("pending");
    expect(def.resources.orders?.lifecycle?.transitions.pay?.to).toBe("paid");
    expect(def.resources.orders?.lifecycle?.transitions.cancel?.to).toBe("cancelled");
    expect(def.resources.orders?.refs).toEqual({ customer_id: "customers" });
    expect(def.resources.products?.scope).toEqual(["store_id"]);
    expect(def.resources.customers?.required).toEqual(["email"]);
    expect(def.conventions?.listStyle).toMatchObject({ kind: "cursor", afterParam: "cursor" });
    expect(report.webhooks).toBe(1);
  });

  it("serves a working stateful twin from the spec", async () => {
    const t = await serveTwin(shop().def, { port: 0 });
    try {
      const j = (r: Response) => r.json() as Promise<Record<string, any>>;
      const cust = await j(await fetch(`${t.url}/v2/customers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }) }));
      expect(cust.email).toBe("a@example.com");
      const bad = await fetch(`${t.url}/v2/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ total: 5, customer_id: "nope" }) });
      expect(bad.status).toBe(400);
      const created = await fetch(`${t.url}/v2/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ total: 1200, currency: "usd", customer_id: cust.id }) });
      expect(created.status).toBe(201);
      const body = await j(created);
      expect(body.ok).toBe(true);
      expect(body.order.id).toMatch(/^ord_[A-Za-z0-9]{12}$/);
      expect(body.order.status).toBe("pending");
      const id = body.order.id;
      expect((await j(await fetch(`${t.url}/v2/orders/${id}/pay`, { method: "POST" }))).order.status).toBe("paid");
      const list = await j(await fetch(`${t.url}/v2/orders?status=paid`));
      expect(list.data.map((o: { id: string }) => o.id)).toEqual([id]);
      expect(list.has_more).toBe(false);
      expect((await fetch(`${t.url}/v2/orders/${id}`, { method: "DELETE" })).status).toBe(204);
      expect((await fetch(`${t.url}/v2/orders/${id}`)).status).toBe(404);
      const notFound = await j(await fetch(`${t.url}/v2/orders/${id}`));
      expect(notFound.error.message).toContain(id);
      // nested scope
      await fetch(`${t.url}/v2/stores/s1/products`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "A" }) });
      expect(await j(await fetch(`${t.url}/v2/stores/s1/products`))).toHaveLength(1);
      expect(await j(await fetch(`${t.url}/v2/stores/s2/products`))).toHaveLength(0);
      // fallback for paths the spec doesn't describe
      const extra = await fetch(`${t.url}/v2/coupons`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEN" }) });
      expect(extra.headers.get("x-mockanything-fallback")).toBe("rest");
      const coupon = await j(extra);
      expect((await j(await fetch(`${t.url}/v2/coupons/${coupon.id}`))).code).toBe("TEN");
    } finally { await t.close(); }
  });
});

describe("local-only server rules", () => {
  let t: RunningTwin;
  let hook: Server;
  beforeAll(async () => {
    t = await serveTwin(shop().def, { port: 0 });
    hook = createServer((_q, s) => s.end("ok"));
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
  });
  afterAll(async () => { await t.close(); await new Promise<void>((r) => hook.close(() => r())); });

  const raw = (path: string, headers: Record<string, string>, method = "GET", body?: string) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: t.port, path, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

  it("refuses requests addressed to other hosts (DNS rebinding)", async () => {
    expect((await raw("/v2/orders", { host: "evil.example" })).status).toBe(421);
    expect((await raw("/v2/orders", { host: `localhost:${t.port}` })).status).toBe(200);
  });
  it("blocks foreign browser origins and allows local ones with CORS", async () => {
    expect((await raw("/v2/orders", { host: "localhost", origin: "https://evil.example" })).status).toBe(403);
    const ok = await raw("/v2/orders", { host: "localhost", origin: "http://localhost:3000" });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect((await raw("/v2/orders", { host: "localhost", "sec-fetch-site": "cross-site" }, "POST", "{}")).status).toBe(403);
    const pre = await raw("/v2/orders", { host: "localhost", origin: "http://localhost:3000", "access-control-request-method": "POST" }, "OPTIONS");
    expect(pre.status).toBe(204);
  });
  it("requires the token for the control API and refuses foreign origins", async () => {
    expect((await raw("/__mockanything/api/state", { host: "localhost" })).status).toBe(401);
    expect((await raw("/__mockanything/api/state", { host: "localhost", "x-mockanything-token": "wrong" })).status).toBe(401);
    expect((await raw("/__mockanything/api/state", { host: "localhost", "x-mockanything-token": t.token })).status).toBe(200);
    expect((await raw("/__mockanything/api/reset", { host: "localhost", "x-mockanything-token": t.token, origin: "https://evil.example" }, "POST", "{}")).status).toBe(403);
    expect((await raw(`/__mockanything/api/state?token=${t.token}`, { host: "localhost" })).status).toBe(401);
    const page = await raw("/__mockanything/", { host: "localhost" });
    expect(page.status).toBe(200);
    expect(String(page.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(page.body).not.toContain(t.token);
  });
  it("streams live updates to a client that sends the token in a header", async () => {
    const r = await fetch(`${t.url}/__mockanything/api/stream`, { headers: { "x-mockanything-token": t.token } });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    setTimeout(() => { void fetch(`${t.url}/v2/orders`); }, 50);
    let got = "";
    while (!got.includes("event:")) { const { value, done } = await reader.read(); if (done) break; got += new TextDecoder().decode(value); }
    expect(got).toMatch(/event: request/);
    await reader.cancel();
  });
  it("only delivers webhooks to localhost unless a host is allowed", () => {
    expect(() => t.twin.addEndpoint("https://example.com/hook")).toThrow(/localhost only/);
    expect(() => t.twin.addEndpoint("http://169.254.169.254/latest")).toThrow();
    expect(() => t.twin.addEndpoint("http://user:pw@localhost/x")).toThrow();
    expect(t.twin.addEndpoint(`http://localhost:${(hook.address() as AddressInfo).port}/x`).url).toContain("localhost");
  });
  it("rejects oversized bodies", async () => {
    const big = "x".repeat(1024 * 1024 + 10);
    const r = await raw("/v2/orders", { host: "localhost", "content-type": "application/json" }, "POST", big).catch(() => ({ status: 413 }));
    expect([413, 400]).toContain(r.status);
  });
});

describe("chaos", () => {
  const def: TwinDefinition = validateDefinition({
    schema: 1, id: "c", title: "C", auth: { type: "none" },
    resources: { things: {} },
    operations: [{ method: "GET", path: "/things", action: "list", resource: "things" }],
  });
  const run = async (seed: number) => {
    const twin = new Twin(def, { baseUrl: "http://localhost", chaos: { modes: ["5xx", "429"], rate: 0.5, seed } });
    const out: number[] = [];
    for (let i = 0; i < 30; i++) out.push((await twin.handle({ method: "GET", path: "/things", headers: {} })).status);
    return out;
  };
  it("is repeatable with a seed and affects roughly the configured share", async () => {
    const a = await run(42);
    const b = await run(42);
    expect(a).toEqual(b);
    const failures = a.filter((s) => s !== 200).length;
    expect(failures).toBeGreaterThan(5);
    expect(failures).toBeLessThan(25);
    expect(await run(7)).not.toEqual(a);
  });
});

describe("spec discovery on docs pages", () => {
  it("finds Swagger UI and Redoc spec links", () => {
    expect(discoverSpecLink(`<script>SwaggerUIBundle({ url: "/v3/api-docs.json" })</script>`, "https://x.example/docs")).toBe("https://x.example/v3/api-docs.json");
    expect(discoverSpecLink(`<redoc spec-url="https://x.example/openapi.yaml"></redoc>`, "https://x.example/")).toBe("https://x.example/openapi.yaml");
    expect(discoverSpecLink(`<a href="/files/openapi.json">Download</a>`, "https://x.example/docs/")).toBe("https://x.example/files/openapi.json");
    expect(discoverSpecLink(`<p>No spec here</p>`, "https://x.example/")).toBeNull();
  });
});

describe("POST on a path variable that is not an object id", () => {
  it("sends (creates) instead of answering 404 (Vonage-style /sms/{format})", async () => {
    const spec = {
      openapi: "3.0.0", info: { title: "SMS", version: "1" },
      paths: { "/sms/{format}": { post: {
        parameters: [{ name: "format", in: "path", required: true, schema: { type: "string", enum: ["json", "xml"] } }],
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Sms" } } } },
        responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Sms" } } } } },
      } } },
      components: { schemas: { Sms: { type: "object", properties: { id: { type: "string" }, to: { type: "string" }, text: { type: "string" } } } } },
    };
    const { def } = ingestOpenApi(spec, "sms.json");
    expect(def.operations.find((o) => o.path === "/sms/{format}")?.action).toBe("create");
    const t = await serveTwin(def, { port: 0 });
    try {
      const r = await fetch(`${t.url}/sms/json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "447700900000", text: "hi" }) });
      expect(r.status).toBeLessThan(300);
    } finally { await t.close(); }
  });
});
