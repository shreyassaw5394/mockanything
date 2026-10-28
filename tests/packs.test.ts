import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Resend } from "resend";
import { Octokit } from "@octokit/rest";
import twilio from "twilio";
import { findPack } from "../src/engine/load.js";
import { serveTwin, type RunningTwin } from "../src/engine/server.js";

interface Hit { path: string; headers: Record<string, string>; body: string }
let hookServer: Server;
let hookBase = "";
const hits: Hit[] = [];
const twins: RunningTwin[] = [];

beforeAll(async () => {
  hookServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", headers: req.headers as Record<string, string>, body });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));
  hookBase = `http://localhost:${(hookServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const t of twins) await t.close();
  await new Promise<void>((r) => hookServer.close(() => r()));
});

async function start(pack: string, path: string, autoScale = 0.05): Promise<RunningTwin> {
  const t = await serveTwin(findPack(pack)!, { port: 0, webhookUrls: [`${hookBase}${path}`], autoScale });
  twins.push(t);
  return t;
}
const waitFor = async (fn: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 15)); }
};

describe("Paystack twin", () => {
  let t: RunningTwin;
  const key = "sk_test_mockanything";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${t.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  beforeAll(async () => { t = await start("paystack", "/paystack"); });

  it("initializes, pays on the test page, verifies and sends a signed charge.success", async () => {
    const init = await call("POST", "/transaction/initialize", { email: "ada@example.com", amount: 500000, callback_url: "http://localhost:3000/verify" });
    expect(init.status).toBe(200);
    expect(init.json.status).toBe(true);
    expect(init.json.message).toBe("Authorization URL created");
    const { authorization_url, reference, access_code } = init.json.data;
    expect(reference).toBeTruthy();
    expect(access_code).toBeTruthy();
    const before = await call("GET", `/transaction/verify/${reference}`);
    expect(before.json.data.status).toBe("abandoned");
    const html = await (await fetch(authorization_url)).text();
    expect(html).toContain("5000.00 NGN");
    expect(html).toContain("Not a real payment");
    const nonce = html.match(/name="nonce" value="([^"]+)"/)![1]!;
    const done = await fetch(`${new URL(authorization_url).origin}${new URL(authorization_url).pathname}/succeed`, { method: "POST", body: new URLSearchParams({ nonce }), redirect: "manual" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`http://localhost:3000/verify?trxref=${reference}&reference=${reference}`);
    const after = await call("GET", `/transaction/verify/${reference}`);
    expect(after.json.message).toBe("Verification successful");
    expect(after.json.data.status).toBe("success");
    expect(after.json.data.amount).toBe(500000);
    expect(after.json.data.customer.email).toBe("ada@example.com");
    expect(after.json.data.authorization.authorization_code).toMatch(/^AUTH_/);
    await waitFor(() => hits.some((h) => h.path === "/paystack" && h.body.includes("charge.success")));
    const hook = hits.find((h) => h.path === "/paystack" && h.body.includes("charge.success"))!;
    const expected = createHmac("sha512", key).update(hook.body).digest("hex");
    expect(hook.headers["x-paystack-signature"]).toBe(expected);
    expect(JSON.parse(hook.body)).toMatchObject({ event: "charge.success", data: { reference, status: "success" } });

    // charge the saved card again
    const again = await call("POST", "/transaction/charge_authorization", { email: "ada@example.com", amount: 100000, authorization_code: after.json.data.authorization.authorization_code });
    expect(again.json.message).toBe("Charge attempted");
    expect(again.json.data.status).toBe("success");
    // refund, processed automatically
    const refund = await call("POST", "/refund", { transaction: reference, amount: 200000 });
    expect(refund.json.message).toBe("Refund has been queued for processing");
    expect(refund.json.data.status).toBe("pending");
    await waitFor(() => hits.some((h) => h.path === "/paystack" && h.body.includes("refund.processed")));
    const over = await call("POST", "/refund", { transaction: reference, amount: 900000 });
    expect(over.status).toBe(400);
    expect(over.json.status).toBe(false);
  });

  it("refuses duplicate references, missing fields, unknown transactions and live keys", async () => {
    const a = await call("POST", "/transaction/initialize", { email: "b@example.com", amount: 100, reference: "order-1" });
    expect(a.status).toBe(200);
    const dup = await call("POST", "/transaction/initialize", { email: "b@example.com", amount: 100, reference: "order-1" });
    expect(dup.status).toBe(400);
    expect(dup.json).toMatchObject({ status: false, message: "Duplicate Transaction Reference" });
    const missing = await call("POST", "/transaction/initialize", { email: "c@example.com" });
    expect(missing.json).toMatchObject({ status: false, message: "amount is required" });
    const none = await call("GET", "/transaction/verify/nope");
    expect(none.status).toBe(404);
    expect(none.json.message).toBe("Transaction not found");
    const live = await fetch(`${t.url}/transaction`, { headers: { authorization: "Bearer sk_live_abc123456" } });
    expect(live.status).toBe(401);
  });

  it("creates and looks up customers by email or code; lists with Paystack's meta", async () => {
    const c = await call("POST", "/customer", { email: "zuri@example.com", first_name: "Zuri" });
    expect(c.json.message).toBe("Customer created");
    expect(c.json.data.customer_code).toMatch(/^CUS_/);
    expect((await call("GET", "/customer/zuri@example.com")).json.data.first_name).toBe("Zuri");
    expect((await call("GET", `/customer/${c.json.data.customer_code}`)).json.data.email).toBe("zuri@example.com");
    const list = await call("GET", "/transaction?perPage=2&page=1");
    expect(list.json.data.length).toBeLessThanOrEqual(2);
    expect(list.json.meta).toMatchObject({ perPage: 2, page: 1 });
  });
});

describe("Resend twin with the official SDK", () => {
  let t: RunningTwin;
  let resend: Resend;
  beforeAll(async () => {
    t = await start("resend", "/resend");
    process.env.RESEND_BASE_URL = t.url;
    resend = new Resend("re_test_mockanything");
  });

  it("sends, retrieves and lists emails, which get delivered with Svix-signed webhooks", async () => {
    const r = await resend.emails.send({ from: "Acme <a@example.com>", to: "delivered@resend.dev", subject: "Welcome", html: "<p>Hi</p>" });
    expect(r.error).toBeNull();
    const id = r.data!.id;
    await waitFor(() => hits.some((h) => h.path === "/resend" && h.body.includes("email.delivered") && h.body.includes(id)));
    const got = await resend.emails.get(id);
    expect(got.data?.subject).toBe("Welcome");
    expect(got.data?.last_event).toBe("delivered");
    expect(got.data?.to).toEqual(["delivered@resend.dev"]);
    const hook = hits.find((h) => h.path === "/resend" && h.body.includes("email.delivered"))!;
    const verified = resend.webhooks.verify({
      payload: hook.body,
      headers: { id: hook.headers["svix-id"]!, timestamp: hook.headers["svix-timestamp"]!, signature: hook.headers["svix-signature"]! },
      webhookSecret: t.twin.webhookSecret,
    });
    expect(verified.type).toBe("email.delivered");
    const list = await resend.emails.list();
    expect(list.data?.data.some((e) => e.id === id)).toBe(true);
  });

  it("bounces mail to bounced@resend.dev and validates required fields", async () => {
    const r = await resend.emails.send({ from: "a@example.com", to: "bounced@resend.dev", subject: "x", text: "x" });
    await waitFor(() => hits.some((h) => h.path === "/resend" && h.body.includes("email.bounced") && h.body.includes(r.data!.id)));
    expect((await resend.emails.get(r.data!.id)).data?.last_event).toBe("bounced");
    const bad = await resend.emails.send({ from: "a@example.com", to: "x@example.com" } as never);
    expect(bad.error?.name).toBe("missing_required_field");
  });

  it("schedules and cancels", async () => {
    const r = await resend.emails.send({ from: "a@example.com", to: "x@example.com", subject: "later", text: "x", scheduledAt: "2030-01-01T00:00:00Z" });
    expect((await resend.emails.get(r.data!.id)).data?.last_event).toBe("scheduled");
    const c = await resend.emails.cancel(r.data!.id);
    expect(c.error).toBeNull();
    expect((await resend.emails.get(r.data!.id)).data?.last_event).toBe("canceled");
  });
});

describe("GitHub twin with Octokit", () => {
  let t: RunningTwin;
  let gh: Octokit;
  beforeAll(async () => {
    t = await start("github", "/github");
    gh = new Octokit({ auth: "placeholder", baseUrl: t.url });
  });

  it("opens, comments on, closes and lists issues per repo, with signed webhooks", async () => {
    const repo = await gh.repos.get({ owner: "acme", repo: "app" });
    expect(repo.data.full_name).toBe("acme/app");
    const a = await gh.issues.create({ owner: "acme", repo: "app", title: "Login times out" });
    const b = await gh.issues.create({ owner: "acme", repo: "app", title: "Second" });
    expect(a.status).toBe(201);
    expect(a.data.number).toBe(1);
    expect(b.data.number).toBe(2);
    const other = await gh.issues.create({ owner: "acme", repo: "other", title: "Elsewhere" });
    expect(other.data.number).toBe(1);
    await gh.issues.createComment({ owner: "acme", repo: "app", issue_number: 1, body: "Repro attached" });
    expect((await gh.issues.get({ owner: "acme", repo: "app", issue_number: 1 })).data.comments).toBe(1);
    const closed = await gh.issues.update({ owner: "acme", repo: "app", issue_number: 1, state: "closed" });
    expect(closed.data.state).toBe("closed");
    expect(closed.data.closed_at).toBeTruthy();
    const open = await gh.issues.listForRepo({ owner: "acme", repo: "app" });
    expect(open.data.map((i) => i.number)).toEqual([2]);
    const all = await gh.issues.listForRepo({ owner: "acme", repo: "app", state: "all" });
    expect(all.data).toHaveLength(2);
    await waitFor(() => hits.some((h) => h.path === "/github" && h.headers["x-github-event"] === "issues" && h.body.includes('"closed"')));
    const hook = hits.find((h) => h.path === "/github" && h.headers["x-github-event"] === "issues")!;
    expect(hook.headers["x-hub-signature-256"]).toBe(`sha256=${createHmac("sha256", t.twin.webhookSecret).update(hook.body).digest("hex")}`);
    expect(JSON.parse(hook.body)).toMatchObject({ action: "opened", repository: { full_name: "acme/app" } });
    await expect(gh.issues.get({ owner: "acme", repo: "app", issue_number: 99 })).rejects.toMatchObject({ status: 404 });
    await expect(gh.issues.create({ owner: "acme", repo: "app" } as never)).rejects.toMatchObject({ status: 422 });
  });

  it("opens and merges pull requests (sharing numbers with issues)", async () => {
    const pr = await gh.pulls.create({ owner: "acme", repo: "app", title: "Fix timeout", head: "fix", base: "main" });
    expect(pr.data.number).toBe(3);
    const m = await gh.pulls.merge({ owner: "acme", repo: "app", pull_number: 3 });
    expect(m.data.merged).toBe(true);
    const after = await gh.pulls.get({ owner: "acme", repo: "app", pull_number: 3 });
    expect(after.data.merged).toBe(true);
    expect(after.data.state).toBe("closed");
    await expect(gh.pulls.merge({ owner: "acme", repo: "app", pull_number: 3 })).rejects.toMatchObject({ status: 422 });
  });

  it("paginates with Link headers", async () => {
    for (let i = 0; i < 5; i++) await gh.issues.create({ owner: "acme", repo: "pages", title: `n${i}` });
    const page = await gh.issues.listForRepo({ owner: "acme", repo: "pages", per_page: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.headers.link).toContain('rel="next"');
    const all = await gh.paginate(gh.issues.listForRepo, { owner: "acme", repo: "pages", per_page: 2 });
    expect(all).toHaveLength(5);
  });
});

describe("Twilio twin with twilio-node", () => {
  let t: RunningTwin;
  const sid = "AC" + "0".repeat(32);
  const token = "test_auth_token";
  let client: ReturnType<typeof twilio>;
  beforeAll(async () => {
    t = await start("twilio", "/unused");
    client = twilio(sid, token);
    client.api.baseUrl = t.url;
  });

  it("sends a message that moves to delivered and posts signed status callbacks", async () => {
    const cb = `${hookBase}/twilio-status`;
    const m = await client.messages.create({ to: "+15555550100", from: "+15555550101", body: "Your code is 123456", statusCallback: cb });
    expect(m.sid).toMatch(/^SM[0-9a-f]{32}$/);
    expect(m.status).toBe("queued");
    expect(m.to).toBe("+15555550100");
    expect(m.body).toBe("Your code is 123456");
    expect(m.dateCreated).toBeInstanceOf(Date);
    await waitFor(() => hits.some((h) => h.path === "/twilio-status" && h.body.includes("MessageStatus=delivered")));
    const hook = hits.find((h) => h.path === "/twilio-status" && h.body.includes("MessageStatus=delivered"))!;
    const params = Object.fromEntries(new URLSearchParams(hook.body));
    expect(twilio.validateRequest(token, hook.headers["x-twilio-signature"]!, cb, params)).toBe(true);
    expect((await client.messages(m.sid).fetch()).status).toBe("delivered");
    const list = await client.messages.list({ limit: 10 });
    expect(list.some((x) => x.sid === m.sid)).toBe(true);
    expect(await client.messages(m.sid).remove()).toBe(true);
    await expect(client.messages(m.sid).fetch()).rejects.toMatchObject({ status: 404, code: 20404 });
  });

  it("returns Twilio's error codes for documented test numbers and missing fields", async () => {
    await expect(client.messages.create({ to: "+15005550001", from: "+15555550101", body: "x" })).rejects.toMatchObject({ status: 400, code: 21211 });
    await expect(client.messages.create({ to: "+15555550100", from: "+15005550008", body: "x" })).rejects.toMatchObject({ code: 21611 });
    await expect(client.messages.create({ to: "+15555550100", from: "+15555550101" } as never)).rejects.toMatchObject({ code: 21602 });
  });

  it("can force an undelivered message", async () => {
    t.twin.forceScenario("undelivered");
    const m = await client.messages.create({ to: "+15555550100", from: "+15555550101", body: "x" });
    await waitFor(() => t.twin.store.get("messages")!.get(m.sid)?.status === "undelivered");
    expect((await client.messages(m.sid).fetch()).errorCode).toBe(30003);
  });
});
