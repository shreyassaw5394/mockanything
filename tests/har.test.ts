import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveSource } from "../src/ingest/resolve.js";
import { serveTwin, type RunningTwin } from "../src/engine/server.js";

// Synthetic recording (never a real one). Secrets are planted to prove nothing from headers or text leaks into the twin.
const SECRET = "sk_test_PLANTEDSECRET123";
const COOKIE = "session=PLANTEDCOOKIE";
const TEXT = "PLANTED private note about a customer";
const H = [{ name: "Authorization", value: `Bearer ${SECRET}` }, { name: "Cookie", value: COOKIE }, { name: "Content-Type", value: "application/json" }];
const entry = (method: string, url: string, status: number, res: unknown, req?: unknown) => ({
  request: { method, url, headers: H, ...(req ? { postData: { mimeType: "application/json", text: JSON.stringify(req) } } : {}) },
  response: { status, content: res === undefined ? { mimeType: "", text: "" } : { mimeType: "application/json; charset=utf-8", text: JSON.stringify(res) } },
});
const order = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, object: "order", status, amount: 4200, currency: "eur", customer_email: "real.person@corp.example", note: TEXT,
  created_at: "2026-10-01T10:00:00Z", paid: status !== "pending", ...extra,
});
const har = {
  log: {
    version: "1.2",
    entries: [
      entry("GET", "https://api.shop.example/v2/orders?limit=2", 200, { data: [order("ord_8Hk2LmQ9", "pending"), order("ord_3Jd7PxW1", "paid")], has_more: false }),
      entry("POST", "https://api.shop.example/v2/orders", 201, order("ord_5Tr9QaZ2", "pending"), { amount: 4200, currency: "eur", customer_email: "real.person@corp.example", note: TEXT }),
      entry("GET", "https://api.shop.example/v2/orders/ord_5Tr9QaZ2", 200, order("ord_5Tr9QaZ2", "pending")),
      entry("POST", "https://api.shop.example/v2/orders/ord_5Tr9QaZ2/cancel", 200, order("ord_5Tr9QaZ2", "cancelled")),
      entry("GET", "https://api.shop.example/v2/orders/ord_missing00", 404, { error: { code: "order_not_found", message: "No such order" } }),
      entry("PATCH", "https://api.shop.example/v2/orders/ord_3Jd7PxW1", 200, order("ord_3Jd7PxW1", "refunded"), { note: TEXT }),
      entry("DELETE", "https://api.shop.example/v2/orders/ord_8Hk2LmQ9", 204, undefined),
      // noise that must be ignored
      { request: { method: "GET", url: "https://shop.example/app.js", headers: [] }, response: { status: 200, content: { mimeType: "application/javascript", text: "console.log(1)" } } },
      { request: { method: "GET", url: "https://cdn.other.example/v1/thing", headers: [] }, response: { status: 200, content: { mimeType: "application/json", text: "{}" } } },
      { request: { method: "OPTIONS", url: "https://api.shop.example/v2/orders", headers: [] }, response: { status: 204, content: {} } },
    ],
  },
};

const dir = mkdtempSync(join(tmpdir(), "mockanything-har-"));
const file = join(dir, "shop.har");
writeFileSync(file, JSON.stringify(har));
let t: RunningTwin | undefined;
afterAll(async () => { await t?.close(); });

describe("HAR recordings", () => {
  it("become a twin without copying secrets or text", async () => {
    const r = await resolveSource(file);
    expect(r.origin).toBe("har");
    expect(r.def.source?.kind).toBe("har");
    expect(r.def.basePath).toBe("/v2");
    expect(r.def.auth.type).toBe("bearer");
    expect(Object.keys(r.def.resources)).toContain("orders");
    const dump = JSON.stringify(r.def);
    for (const planted of [SECRET, "PLANTEDCOOKIE", "PLANTED private note", "real.person@corp.example"]) expect(dump).not.toContain(planted);
    expect(r.report?.guesses[0]).toMatch(/Built from 7 of 10 recorded requests to api\.shop\.example/);
  });

  it("serves a stateful twin that behaves like the recording", async () => {
    const r = await resolveSource(file);
    t = await serveTwin(r.def, { port: 0 });
    const base = `${t.url}/v2`;
    const auth = { authorization: "Bearer sk_test_anything", "content-type": "application/json" };
    const created = await (await fetch(`${base}/orders`, { method: "POST", headers: auth, body: JSON.stringify({ amount: 900, currency: "eur" }) })).json() as Record<string, unknown>;
    expect(String(created.id)).toMatch(/^ord_/);
    expect(created.status).toBe("pending");
    expect(created.amount).toBe(900);
    const read = await (await fetch(`${base}/orders/${created.id}`, { headers: auth })).json() as Record<string, unknown>;
    expect(read.id).toBe(created.id);
    const cancelled = await (await fetch(`${base}/orders/${created.id}/cancel`, { method: "POST", headers: auth })).json() as Record<string, unknown>;
    expect(cancelled.status).toBe("cancelled");
    const missing = await fetch(`${base}/orders/ord_nope0000`, { headers: auth });
    expect(missing.status).toBe(404);
    // inferred twins accept any key (or none), like every inferred twin
    expect((await fetch(`${base}/orders`)).status).toBe(200);
  });

  it("explains a recording with no API calls", async () => {
    const empty = join(dir, "empty.har");
    writeFileSync(empty, JSON.stringify({ log: { entries: [har.log.entries[7]] } }));
    await expect(resolveSource(empty)).rejects.toThrow(/no JSON API requests/);
  });
});
