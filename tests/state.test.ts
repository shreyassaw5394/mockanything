import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { findPack } from "../src/engine/load.js";
import { serveTwin } from "../src/engine/server.js";

const dir = mkdtempSync(join(tmpdir(), "mockanything-state-"));
const sdk = (port: number) => new Stripe("sk_test_mockanything", { host: "localhost", port, protocol: "http", maxNetworkRetries: 0 });

describe("saved state", () => {
  it("keeps objects, ids, webhook secret and endpoints across restarts", async () => {
    const statePath = join(dir, "stripe.json");
    const a = await serveTwin(findPack("stripe")!, { port: 0, statePath, webhookUrls: ["http://localhost:9/hooks"] });
    expect(a.state).toMatchObject({ path: statePath, restored: 0 });
    const s1 = sdk(a.port);
    const cus = await s1.customers.create({ email: "keep@example.com" });
    const pi = await s1.paymentIntents.create({ amount: 1200, currency: "usd", customer: cus.id, payment_method: "pm_card_visa", confirm: true });
    const secret = a.twin.webhookSecret;
    await a.close();

    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved).toMatchObject({ mockanything: 1, twin: "stripe" });

    const b = await serveTwin(findPack("stripe")!, { port: 0, statePath });
    expect(b.state?.restored).toBeGreaterThanOrEqual(2);
    expect(b.twin.webhookSecret).toBe(secret);
    expect(b.twin.listEndpoints().map((e) => e.url)).toEqual(["http://localhost:9/hooks"]);
    const s2 = sdk(b.port);
    expect((await s2.customers.retrieve(cus.id)) as Stripe.Customer).toMatchObject({ id: cus.id, email: "keep@example.com" });
    expect((await s2.paymentIntents.retrieve(pi.id)).status).toBe("succeeded");
    expect((await s2.customers.list()).data.map((c) => c.id)).toContain(cus.id);
    // new objects still work after a restore
    const cus2 = await s2.customers.create({ email: "second@example.com" });
    expect(cus2.id).not.toBe(cus.id);
    await b.close();
  });

  it("saves while running, not only on close", async () => {
    const statePath = join(dir, "live.json");
    const t = await serveTwin(findPack("stripe")!, { port: 0, statePath });
    await sdk(t.port).customers.create({ email: "live@example.com" });
    await new Promise((r) => setTimeout(r, 500));
    expect(readFileSync(statePath, "utf8")).toContain("live@example.com");
    await t.close();
  });

  it("refuses a state file from a different twin, and junk files", async () => {
    const statePath = join(dir, "wrong.json");
    const a = await serveTwin(findPack("paystack")!, { port: 0, statePath });
    await a.close();
    await expect(serveTwin(findPack("stripe")!, { port: 0, statePath })).rejects.toThrow(/saved by the "paystack" twin/);
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "not json");
    await expect(serveTwin(findPack("stripe")!, { port: 0, statePath: junk })).rejects.toThrow(/not valid JSON/);
  });

  it("reset clears the saved file too", async () => {
    const statePath = join(dir, "reset.json");
    const t = await serveTwin(findPack("stripe")!, { port: 0, statePath });
    await sdk(t.port).customers.create({ email: "gone@example.com" });
    t.twin.reset();
    await t.close();
    expect(readFileSync(statePath, "utf8")).not.toContain("gone@example.com");
  });
});
