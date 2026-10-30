import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findPack } from "../src/engine/load.js";
import { serveTwin, type RunningTwin } from "../src/engine/server.js";
import { autoSuite, compareBodies, idShape, loadSuite, reportMarkdown, runVerify } from "../src/verify/verify.js";
import type { TwinDefinition } from "../src/engine/types.js";

// A second twin stands in for "the real API", so these tests never touch a provider.
let stripeReal: RunningTwin;
let paystackReal: RunningTwin;
beforeAll(async () => {
  stripeReal = await serveTwin(findPack("stripe")!, { port: 0 });
  paystackReal = await serveTwin(findPack("paystack")!, { port: 0 });
});
afterAll(async () => { await stripeReal.close(); await paystackReal.close(); });

describe("verify", () => {
  it("scores a twin against an identical API at 100%", async () => {
    const r = await runVerify(findPack("stripe")!, loadSuite("stripe"), { key: "sk_test_verify", against: stripeReal.url });
    expect(r.steps).toHaveLength(loadSuite("stripe").steps.length);
    for (const s of r.steps) expect({ id: s.id, score: s.score, diffs: [...s.missing, ...s.extra, ...s.typeDiffs, ...s.valueDiffs] }).toEqual({ id: s.id, score: 100, diffs: [] });
    expect(r.score).toBe(100);
    expect(r.steps.find((s) => s.id === "declined")?.status).toEqual({ twin: 402, real: 402 });
    expect(r.steps.find((s) => s.id === "no_key")?.status).toEqual({ twin: 401, real: 401 });
    expect(r.against).toBe("a server on this machine");
  });

  it("runs the Paystack suite end to end", async () => {
    const r = await runVerify(findPack("paystack")!, loadSuite("paystack"), { key: "sk_test_verify", against: paystackReal.url });
    expect(r.score).toBe(100);
    expect(r.steps.find((s) => s.id === "trx_missing")?.status.real).toBeGreaterThanOrEqual(400);
  });

  it("finds missing fields and wrong id formats", async () => {
    const def = structuredClone(findPack("stripe")!) as TwinDefinition;
    delete def.resources.customers!.defaults!.balance;
    def.resources.customers!.id = { style: "prefixed", prefix: "cust_", length: 14 };
    const r = await runVerify(def, loadSuite("stripe"), { key: "sk_test_verify", against: stripeReal.url });
    const create = r.steps.find((s) => s.id === "customer_create")!;
    expect(create.missing).toContain("balance");
    expect(create.valueDiffs.some((d) => d.startsWith("id id format: twin cust_"))).toBe(true);
    expect(create.score).toBeLessThan(100);
    expect(r.score).toBeLessThan(100);
    const md = reportMarkdown(r);
    expect(md).toMatch(/^# Stripe twin fidelity: \d+(\.\d)?%/);
    expect(md).toContain("Missing in the twin: `balance`");
  });

  it("never runs with a live key, a non-test key, or plain http to a public host", async () => {
    const def = findPack("stripe")!;
    const suite = loadSuite("stripe");
    await expect(runVerify(def, suite, { key: "sk_live_abc", against: stripeReal.url })).rejects.toThrow(/live key/);
    await expect(runVerify(def, suite, { key: "rzp_live_abc", against: stripeReal.url })).rejects.toThrow(/live key/);
    await expect(runVerify(def, suite, { key: "abc123", against: stripeReal.url })).rejects.toThrow(/test key/);
    await expect(runVerify(def, suite, { key: "", against: stripeReal.url })).rejects.toThrow(/key is required/);
    await expect(runVerify(def, suite, { key: "sk_test_x", against: "http://api.example.com" })).rejects.toThrow(/https/);
    await expect(runVerify(def, suite, { key: "sk_test_x", against: stripeReal.url, maxCalls: 3 })).rejects.toThrow(/more than the limit/);
  });

  it("keeps response data out of the report", async () => {
    const r = await runVerify(findPack("stripe")!, loadSuite("stripe"), { key: "sk_test_SECRETKEY", against: stripeReal.url });
    const text = JSON.stringify(r);
    expect(text).not.toContain("SECRETKEY");
    expect(text).not.toContain("verify@example.com");
    expect(text).not.toMatch(/cus_(?!mockanythingmissing)[A-Za-z0-9]{10,}/);
    expect(text).not.toMatch(/pi_[A-Za-z0-9]{10,}/);
  });

  it("builds a read-only suite for any twin", () => {
    const s = autoSuite(findPack("paystack")!, "https://api.paystack.co");
    expect(() => autoSuite(findPack("github")!, "https://api.github.com")).toThrow(/no list calls/);
    expect(s.steps.length).toBeGreaterThan(0);
    expect(s.steps.every((x) => x.method === "GET")).toBe(true);
  });

  it("compares shapes, types and codes", () => {
    const c = compareBodies(
      { id: "cus_abc", object: "customer", n: 1, nested: { a: "x" }, only_twin: true },
      { id: "cus_def", object: "customer", n: "1", nested: { a: "y", b: 2 }, deleted: null },
    );
    expect(c.missing).toEqual(["deleted", "nested.b"]);
    expect(c.extra).toEqual(["only_twin"]);
    expect(c.typeDiffs).toEqual(["n: twin number, real string"]);
    expect(c.valueDiffs).toEqual([]);
    expect(idShape("cus_NffrFeUfNV2Hib")).toBe("cus_[mixed]{14}");
    expect(idShape("CUS_xyz123")).toBe("CUS_[a-z0-9]{6}");
  });
});
