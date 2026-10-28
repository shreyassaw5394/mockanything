import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { findPack } from "../src/engine/load.js";
import { serveTwin, type RunningTwin } from "../src/engine/server.js";

let twin: RunningTwin;
let stripe: Stripe;
let hookServer: Server;
let hookUrl: string;
const received: { type: string; verified: boolean }[] = [];

beforeAll(async () => {
  hookServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const ev = stripe.webhooks.constructEvent(body, String(req.headers["stripe-signature"]), twin.twin.webhookSecret);
        received.push({ type: ev.type, verified: true });
      } catch {
        received.push({ type: "?", verified: false });
      }
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));
  hookUrl = `http://localhost:${(hookServer.address() as AddressInfo).port}/hooks`;
  twin = await serveTwin(findPack("stripe")!, { port: 0, webhookUrls: [hookUrl] });
  stripe = new Stripe("sk_test_mockanything", { host: "localhost", port: twin.port, protocol: "http", maxNetworkRetries: 0 });
});

afterAll(async () => {
  await twin.close();
  await new Promise<void>((r) => hookServer.close(() => r()));
});

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};

describe("Stripe twin with the official SDK", () => {
  it("creates, reads, updates, lists and deletes customers", async () => {
    const c = await stripe.customers.create({ email: "ada@example.com", name: "Ada", metadata: { plan: "pro" } });
    expect(c.id).toMatch(/^cus_[A-Za-z0-9]{14}$/);
    expect(c.object).toBe("customer");
    expect(c.metadata).toEqual({ plan: "pro" });
    const got = await stripe.customers.retrieve(c.id);
    expect((got as Stripe.Customer).email).toBe("ada@example.com");
    const upd = await stripe.customers.update(c.id, { name: "Ada Lovelace", metadata: { team: "x" } });
    expect(upd.name).toBe("Ada Lovelace");
    expect(upd.metadata).toEqual({ plan: "pro", team: "x" });
    const list = await stripe.customers.list({ email: "ada@example.com" });
    expect(list.object).toBe("list");
    expect(list.data.map((x) => x.id)).toContain(c.id);
    const del = await stripe.customers.del(c.id);
    expect(del.deleted).toBe(true);
    await expect(stripe.customers.retrieve(c.id)).rejects.toMatchObject({ statusCode: 404, code: "resource_missing" });
  });

  it("runs a successful payment and sends verifiable webhooks", async () => {
    const pi = await stripe.paymentIntents.create({ amount: 2000, currency: "usd", payment_method: "pm_card_visa", confirm: true });
    expect(pi.status).toBe("succeeded");
    expect(pi.amount).toBe(2000);
    expect(pi.amount_received).toBe(2000);
    expect(pi.client_secret).toMatch(new RegExp(`^${pi.id}_secret_`));
    await waitFor(() => received.some((r) => r.type === "payment_intent.succeeded"));
    expect(received.every((r) => r.verified)).toBe(true);
    const events = await stripe.events.list({ type: "payment_intent.succeeded" });
    expect(events.data[0]?.data.object).toMatchObject({ id: pi.id });
  });

  it("declines a declined test card with Stripe's error shape and keeps the PaymentIntent", async () => {
    const pi = await stripe.paymentIntents.create({ amount: 500, currency: "usd" });
    expect(pi.status).toBe("requires_payment_method");
    const err = await stripe.paymentIntents.confirm(pi.id, { payment_method: "pm_card_chargeDeclined" }).catch((e) => e);
    expect(err).toBeInstanceOf(Stripe.errors.StripeCardError);
    expect(err.code).toBe("card_declined");
    expect(err.decline_code).toBe("generic_decline");
    expect(err.statusCode).toBe(402);
    const after = await stripe.paymentIntents.retrieve(pi.id);
    expect(after.status).toBe("requires_payment_method");
    expect(after.last_payment_error?.code).toBe("card_declined");
  });

  it("supports manual capture, partial refunds and refuses over-refunds", async () => {
    const pi = await stripe.paymentIntents.create({ amount: 3000, currency: "eur", capture_method: "manual", payment_method: "pm_card_visa", confirm: true });
    expect(pi.status).toBe("requires_capture");
    expect(pi.amount_capturable).toBe(3000);
    const cap = await stripe.paymentIntents.capture(pi.id);
    expect(cap.status).toBe("succeeded");
    const r1 = await stripe.refunds.create({ payment_intent: pi.id, amount: 1000 });
    expect(r1.amount).toBe(1000);
    expect(r1.status).toBe("succeeded");
    expect(r1.currency).toBe("eur");
    await expect(stripe.refunds.create({ payment_intent: pi.id, amount: 2500 })).rejects.toMatchObject({ code: "amount_too_large" });
    const r2 = await stripe.refunds.create({ payment_intent: pi.id });
    expect(r2.amount).toBe(2000);
    await expect(stripe.refunds.create({ payment_intent: pi.id })).rejects.toMatchObject({ code: "charge_already_refunded" });
  });

  it("refuses invalid state changes", async () => {
    const pi = await stripe.paymentIntents.create({ amount: 100, currency: "usd", payment_method: "pm_card_visa", confirm: true });
    await expect(stripe.paymentIntents.cancel(pi.id)).rejects.toMatchObject({ code: "payment_intent_unexpected_state" });
  });

  it("requires authentication for 3-D Secure test cards and completes on the test page", async () => {
    const pi = await stripe.paymentIntents.create({ amount: 1500, currency: "usd", payment_method: "pm_card_threeDSecure2Required", confirm: true, return_url: "http://localhost:3000/done" });
    expect(pi.status).toBe("requires_action");
    const url = pi.next_action?.redirect_to_url?.url;
    expect(url).toContain("/__mockanything/checkout/payment_intents/");
    const page = await fetch(url!);
    const html = await page.text();
    expect(html).toContain("Not a real payment");
    expect(html).toContain("15.00 USD");
    const nonce = html.match(/name="nonce" value="([^"]+)"/)![1]!;
    const action = new URL(url!).pathname + "/succeed";
    const done = await fetch(`${twin.url}${action}`, { method: "POST", body: new URLSearchParams({ nonce }), redirect: "manual" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("http://localhost:3000/done");
    expect((await stripe.paymentIntents.retrieve(pi.id)).status).toBe("succeeded");
    // a nonce works once
    const again = await fetch(`${twin.url}${action}`, { method: "POST", body: new URLSearchParams({ nonce }), redirect: "manual" });
    expect(again.status).toBe(400);
  });

  it("creates Checkout Sessions with a local test page", async () => {
    const s = await stripe.checkout.sessions.create({
      mode: "payment", success_url: "http://localhost:3000/ok?session={CHECKOUT_SESSION_ID}", cancel_url: "http://localhost:3000/cancel",
      line_items: [{ price_data: { currency: "usd", unit_amount: 1250, product_data: { name: "T-shirt" } }, quantity: 2 }],
    });
    expect(s.amount_total).toBe(2500);
    expect(s.status).toBe("open");
    expect(s.url).toContain("/__mockanything/checkout/checkout_sessions/");
    const html = await (await fetch(s.url!)).text();
    const nonce = html.match(/name="nonce" value="([^"]+)"/)![1]!;
    const done = await fetch(`${new URL(s.url!).origin}${new URL(s.url!).pathname}/succeed`, { method: "POST", body: new URLSearchParams({ nonce }), redirect: "manual" });
    expect(done.headers.get("location")).toBe(`http://localhost:3000/ok?session=${s.id}`);
    const after = await stripe.checkout.sessions.retrieve(s.id);
    expect(after.payment_status).toBe("paid");
    await waitFor(() => received.some((r) => r.type === "checkout.session.completed"));
  });

  it("validates required params, missing refs and pagination", async () => {
    await expect(stripe.paymentIntents.create({ currency: "usd" } as never)).rejects.toMatchObject({ code: "parameter_missing", param: "amount" });
    await expect(stripe.paymentIntents.create({ amount: 1, currency: "usd", customer: "cus_nope" })).rejects.toMatchObject({ statusCode: 400, code: "resource_missing", param: "customer" });
    for (let i = 0; i < 5; i++) await stripe.customers.create({ email: `p${i}@example.com` });
    const page1 = await stripe.customers.list({ limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    const page2 = await stripe.customers.list({ limit: 2, starting_after: page1.data[1]!.id });
    expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id);
    const all: string[] = [];
    for await (const c of stripe.customers.list({ limit: 2 })) all.push(c.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("refuses live keys and real card numbers, and replays idempotent requests", async () => {
    const live = new Stripe("sk_live_123456789", { host: "localhost", port: twin.port, protocol: "http", maxNetworkRetries: 0 });
    await expect(live.customers.list()).rejects.toMatchObject({ statusCode: 401 });
    const res = await fetch(`${twin.url}/v1/customers`, {
      method: "POST", headers: { authorization: "Bearer sk_test_x", "content-type": "application/x-www-form-urlencoded" },
      body: "metadata[card_number]=4539148803436467",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("real_card_refused");
    const a = await stripe.customers.create({ email: "idem@example.com" }, { idempotencyKey: "k1" });
    const b = await stripe.customers.create({ email: "idem@example.com" }, { idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
  });

  it("registers webhook endpoints through the API, localhost only", async () => {
    const ep = await stripe.webhookEndpoints.create({ url: `${hookUrl}?second=1`, enabled_events: ["customer.created"] });
    expect(ep.secret).toMatch(/^whsec_/);
    await expect(stripe.webhookEndpoints.create({ url: "https://example.com/hook", enabled_events: ["*"] })).rejects.toMatchObject({ statusCode: 400 });
  });
});
