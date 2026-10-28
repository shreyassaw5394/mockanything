import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";

let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, any> };
  return r;
};

beforeAll(async () => {
  const server = createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
});
afterAll(async () => {
  for (const t of ["stripe", "acme-pay"]) await call("twin_stop", { twin: t });
  await client.close();
});

describe("MCP server", () => {
  it("lists its tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["twin_start", "twin_from_docs", "twin_events", "twin_state", "twin_scenario", "twin_chaos", "twin_stop"]) expect(names).toContain(n);
  });

  it("starts the Stripe pack, then an agent can drive and inspect it", async () => {
    const started = await call("twin_start", { source: "stripe" });
    expect(started.isError).toBeFalsy();
    const info = started.structuredContent!;
    expect(info.baseUrl).toMatch(/^http:\/\/localhost:\d+\/v1$/);
    expect(info.snippets.node).toContain("sk_test_mockanything");
    const res = await fetch(`${info.baseUrl}/customers`, { method: "POST", headers: { authorization: "Bearer sk_test_x", "content-type": "application/x-www-form-urlencoded" }, body: "email=agent@example.com" });
    expect(res.status).toBe(200);
    const state = await call("twin_state", { resource: "customers" });
    expect(state.structuredContent!.customers.items[0].email).toBe("agent@example.com");
    const events = await call("twin_events", {});
    expect(events.structuredContent!.requests[0].requestHeaders.authorization).toBe("Bearer sk_test_••••");
    const sc = await call("twin_scenario", {});
    expect(sc.structuredContent!.scenarios.map((s: { name: string }) => s.name)).toContain("card_declined");
    await call("twin_scenario", { name: "card_declined" });
    const pi = await fetch(`${info.baseUrl}/payment_intents`, { method: "POST", headers: { authorization: "Bearer sk_test_x", "content-type": "application/x-www-form-urlencoded" }, body: "amount=100&currency=usd&payment_method=pm_card_visa&confirm=true" });
    expect(pi.status).toBe(402);
  });

  it("accepts a definition written by an agent and explains invalid ones", async () => {
    const bad = await call("twin_start", { definition: { schema: 1, id: "x", title: "X", auth: { type: "none" }, resources: {}, operations: [{ method: "GET", path: "/a", action: "read", resource: "missing" }] } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("unknown resource");
    const good = await call("twin_start", {
      definition: {
        schema: 1, id: "acme-pay", title: "Acme Pay", basePath: "/v1", auth: { type: "bearer" },
        conventions: { single: { ok: true, data: "{{$data}}" }, createStatus: 201 },
        resources: { payments: { id: { style: "prefixed", prefix: "pay_", length: 10 }, required: ["amount"], types: { amount: "integer" },
          lifecycle: { field: "status", initial: "pending", transitions: { capture: { from: ["pending"], to: "captured" } } } } },
        operations: [
          { method: "POST", path: "/payments", action: "create", resource: "payments" },
          { method: "POST", path: "/payments/{id}/capture", action: "transition", resource: "payments", transition: "capture" },
        ],
      },
    });
    expect(good.isError).toBeFalsy();
    const base = good.structuredContent!.baseUrl;
    const p = await (await fetch(`${base}/payments`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ amount: "500" }) })).json() as { data: { id: string; amount: number; status: string } };
    expect(p.data).toMatchObject({ amount: 500, status: "pending" });
    const c = await (await fetch(`${base}/payments/${p.data.id}/capture`, { method: "POST", headers: { authorization: "Bearer x" } })).json() as { data: { status: string } };
    expect(c.data.status).toBe("captured");
  });

  it("refuses non-spec files", async () => {
    const r = await call("twin_start", { source: "/etc/passwd" });
    expect(r.isError).toBe(true);
  });
});
