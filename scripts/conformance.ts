/**
 * Conformance check for spec inference: boot twins straight from real public OpenAPI specs
 * (no hand-written pack) and drive them with each provider's official SDK.
 *
 *   npx tsx scripts/conformance.ts <dir-with-specs>
 *
 * Expects stripe.json, twilio_api.json, github.json, resend.yaml in the directory
 * (see README "Conformance" for the download URLs). Prints pass/fail per step.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import twilio from "twilio";
import { Octokit } from "@octokit/rest";
import { Resend } from "resend";
import { parseDocument } from "../src/engine/load.js";
import { ingestOpenApi } from "../src/ingest/openapi.js";
import { serveTwin } from "../src/engine/server.js";

const dir = process.argv[2] ?? ".";
let pass = 0;
let fail = 0;
async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}: ${(e as Error).message?.slice(0, 300)}`); }
}
function expect(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

async function boot(file: string) {
  const { def, report } = ingestOpenApi(parseDocument(readFileSync(join(dir, file), "utf8")), file);
  const t = await serveTwin(def, { port: 0 });
  console.log(`\n${def.title}: ${report.operations.total} operations, ${report.resources.length} resources, list ${report.listStyle}, auth ${report.auth}`);
  return t;
}

async function stripeFlow() {
  if (!existsSync(join(dir, "stripe.json"))) return;
  const t = await boot("stripe.json");
  const stripe = new Stripe("sk_test_x", { host: "localhost", port: t.port, protocol: "http", maxNetworkRetries: 0 });
  let cid = "";
  await step("customers.create", async () => { const c = await stripe.customers.create({ email: "a@example.com", name: "Ada" }); cid = c.id; expect(c.email === "a@example.com", `email ${c.email}`); expect(c.object === "customer", `object ${c.object}`); });
  await step("customers.retrieve", async () => { const c = (await stripe.customers.retrieve(cid)) as Stripe.Customer; expect(c.name === "Ada", "name"); });
  await step("customers.update", async () => { const c = await stripe.customers.update(cid, { name: "Ada L" }); expect(c.name === "Ada L", "name"); });
  await step("customers.list", async () => { const l = await stripe.customers.list(); expect(l.data.some((x) => x.id === cid), "missing"); expect(l.object === "list", "object"); });
  await step("customers.del", async () => { const d = await stripe.customers.del(cid); expect(d.deleted === true, `deleted ${JSON.stringify(d)}`); });
  await step("customers.retrieve (deleted) → 404", async () => { const e = await stripe.customers.retrieve(cid).catch((x) => x); expect(e?.statusCode === 404, `status ${e?.statusCode}`); });
  let pid = "";
  await step("paymentIntents.create", async () => { const p = await stripe.paymentIntents.create({ amount: 1000, currency: "usd" }); pid = p.id; expect(p.amount === 1000, `amount ${p.amount}`); expect(p.status === "requires_payment_method", `status ${p.status}`); });
  await step("paymentIntents.confirm → succeeded", async () => { const p = await stripe.paymentIntents.confirm(pid, { payment_method: "pm_card_visa" }); expect(p.status === "succeeded", `status ${p.status}`); });
  await step("paymentIntents.create missing amount → 400", async () => { const e = await stripe.paymentIntents.create({ currency: "usd" } as never).catch((x) => x); expect(e?.statusCode === 400, `status ${e?.statusCode}`); });
  await t.close();
}

async function twilioFlow() {
  if (!existsSync(join(dir, "twilio_api.json"))) return;
  const t = await boot("twilio_api.json");
  const client = twilio("AC" + "0".repeat(32), "test_token", {});
  // twilio-node builds hosts from the domain; send its requests to the twin instead
  const origRequest = client.request.bind(client);
  client.request = (opts: Parameters<typeof origRequest>[0]) => origRequest({ ...opts, uri: String(opts.uri).replace(/^https:\/\/api\.twilio\.com/, t.url) });
  let sid = "";
  await step("messages.create", async () => { const m = await client.messages.create({ to: "+15555550100", from: "+15555550101", body: "hi" }); sid = m.sid; expect(m.to === "+15555550100", `to ${m.to}`); expect(m.body === "hi", `body ${m.body}`); expect(m.status === "queued", `status ${m.status}`); });
  await step("messages(sid).fetch", async () => { const m = await client.messages(sid).fetch(); expect(m.sid === sid, "sid"); });
  await step("messages.list", async () => { const l = await client.messages.list({ limit: 5 }); expect(l.some((m) => m.sid === sid), `missing (${l.length})`); });
  await step("messages(sid).remove", async () => { const ok = await client.messages(sid).remove(); expect(ok === true, `remove ${ok}`); });
  await t.close();
}

async function githubFlow() {
  if (!existsSync(join(dir, "github.json"))) return;
  const t = await boot("github.json");
  const gh = new Octokit({ auth: "placeholder", baseUrl: t.url });
  let num = 0;
  await step("issues.create", async () => { const r = await gh.issues.create({ owner: "o", repo: "r", title: "Bug" }); num = r.data.number; expect(r.status === 201, `status ${r.status}`); expect(r.data.title === "Bug", "title"); });
  await step("issues.get", async () => { const r = await gh.issues.get({ owner: "o", repo: "r", issue_number: num }); expect(r.data.title === "Bug", `title ${r.data.title}`); });
  await step("issues.update", async () => { const r = await gh.issues.update({ owner: "o", repo: "r", issue_number: num, title: "Bug 2" }); expect(r.data.title === "Bug 2", "title"); });
  await step("issues.listForRepo", async () => { const r = await gh.issues.listForRepo({ owner: "o", repo: "r" }); expect(r.data.some((i) => i.number === num), `missing (${r.data.length})`); });
  await step("issues in other repo are separate", async () => { const r = await gh.issues.listForRepo({ owner: "o", repo: "other" }); expect(r.data.length === 0, `got ${r.data.length}`); });
  await t.close();
}

async function resendFlow() {
  if (!existsSync(join(dir, "resend.yaml"))) return;
  const t = await boot("resend.yaml");
  process.env.RESEND_BASE_URL = t.url;
  const resend = new Resend("re_test_x");
  let id = "";
  await step("emails.send", async () => { const r = await resend.emails.send({ from: "a@example.com", to: "b@example.com", subject: "Hi", html: "<p>x</p>" }); expect(!r.error, JSON.stringify(r.error)); id = r.data!.id; expect(!!id, "id"); });
  await step("emails.get", async () => { const r = await resend.emails.get(id); expect(!r.error, JSON.stringify(r.error)); expect(r.data?.subject === "Hi", `subject ${r.data?.subject}`); });
  await t.close();
}

await stripeFlow();
await twilioFlow();
await githubFlow();
await resendFlow();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
