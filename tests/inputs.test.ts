import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { checkMcpSource, createMcpServer } from "../src/mcp/server.js";
import { parseDocument } from "../src/engine/load.js";
import { resolveSource } from "../src/ingest/resolve.js";
import { safeMatch, safeRegex } from "../src/engine/template.js";
import { needsKeyConfirm, redactKey } from "../src/verify/verify.js";
import { harToOpenApi, synthId } from "../src/ingest/har.js";

const PLANTED = "PLANTED_LINE_abc123";
const dir = realpathSync(mkdtempSync(join(tmpdir(), "mockanything-inputs-")));
writeFileSync(join(dir, ".env"), `SECRET_TOKEN=${PLANTED}\n`);
writeFileSync(join(dir, "notes.yaml"), `a: b\n  ${PLANTED}: [\n`);
writeFileSync(join(dir, "bad.json"), `{"k": ${PLANTED}}`);
mkdirSync(join(dir, ".config"));
writeFileSync(join(dir, ".config", "creds.json"), `{"token":"${PLANTED}"}`);
mkdirSync(join(dir, "specs"));
writeFileSync(join(dir, "specs", "api.yaml"), "openapi: 3.0.3\ninfo: { title: t, version: '1' }\npaths: {}\n");

let local: Server;
let localUrl = "";
beforeAll(async () => {
  local = createServer((req, res) => {
    if (req.url === "/page.html") { res.setHeader("content-type", "text/html"); res.end(`<html><a href="${localUrl}/openapi.json">x</a></html>`); return; }
    res.setHeader("content-type", "text/plain"); res.end(PLANTED);
  });
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
  localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => local.close(() => r())));

describe("parse errors", () => {
  it("never quote the text", () => {
    for (const text of [`SECRET_TOKEN=${PLANTED}\nX: [`, `{"k": ${PLANTED}}`, `a: b\n  ${PLANTED}: [\n`]) {
      let msg = "";
      try { parseDocument(text, "f"); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/^f is not valid/);
      expect(msg).not.toContain(PLANTED);
    }
  });
});

describe("MCP twin_start sources", () => {
  it("refuse hidden files, non-spec files and paths outside the working directory", () => {
    expect(checkMcpSource(".env", dir)).toMatch(/Files must be/);
    expect(checkMcpSource("./.env", dir)).toMatch(/Files must be/);
    expect(checkMcpSource(".config/creds.json", dir)).toMatch(/Files must be/);
    expect(checkMcpSource(join(dir, ".config", "creds.json"), join(dir, "specs"))).toMatch(/Files must be/);
    expect(checkMcpSource("/etc/hosts", dir)).toMatch(/Files must be/);
    expect(checkMcpSource("../x.json", join(dir, "specs"))).toBeTruthy();
    expect(checkMcpSource("specs/api.yaml", dir)).toBeNull();
    expect(checkMcpSource("stripe", dir)).toBeNull();
    expect(checkMcpSource("slack", dir)).toBeNull();
    expect(checkMcpSource("http://127.0.0.1:9/x.json", dir)).toMatch(/this machine/);
    expect(checkMcpSource("https://example.com/openapi.json", dir)).toBeNull();
  });

  it("return errors without file content", async () => {
    const server = createMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      for (const source of [".env", "notes.yaml", "bad.json", join(dir, ".config", "creds.json"), `${localUrl}/x.json`]) {
        const r = (await client.callTool({ name: "twin_start", arguments: { source } })) as { content: { text: string }[]; isError?: boolean };
        expect(r.isError).toBe(true);
        expect(r.content[0]!.text).not.toContain(PLANTED);
      }
    } finally { process.chdir(cwd); await client.close(); }
  });
});

describe("spec URLs", () => {
  it("only fetch this machine when the caller allows it", async () => {
    await expect(resolveSource(`${localUrl}/x.json`)).rejects.toThrow();
    const err = await resolveSource(`${localUrl}/x.json`, { allowLocal: true }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(PLANTED);
  });
});

describe("definition regexes", () => {
  it("refuse catastrophic or oversized patterns and bound the input", () => {
    for (const p of ["(a+)+$", "(a|aa)+$", "(a*)*b", "(x)\\1", "a".repeat(201)]) expect(safeRegex(p)).toBeNull();
    expect(safeRegex("^(sk|rk)_live_")).not.toBeNull();
    expect(safeRegex("^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{30,}")).not.toBeNull();
    expect(safeMatch("^a", "a".repeat(20_000))).toBe(false);
    expect(safeMatch("^a", "abc")).toBe(true);
  });
});

describe("verify key handling", () => {
  it("asks before sending a key to a host no built-in suite uses", () => {
    expect(needsKeyConfirm("https://evil.example")).toBe(true);
    expect(needsKeyConfirm("https://api.stripe.com")).toBe(false);
    expect(needsKeyConfirm("https://api.paystack.co/")).toBe(false);
    expect(needsKeyConfirm("http://localhost:4010")).toBe(false);
  });
  it("redacts every form of the key", () => {
    const key = "sk_test_abc:123";
    const msg = `a ${key} b ${key} c ${encodeURIComponent(key)} d ${Buffer.from(key).toString("base64")}`;
    const out = redactKey(msg, key);
    expect(out).not.toContain(key);
    expect(out).not.toContain(encodeURIComponent(key));
    expect(out).not.toContain(Buffer.from(key).toString("base64"));
    expect(redactKey("x sk_test_k y", "sk_test_k")).toBe("x <key> y");
    expect(redactKey(`Basic ${Buffer.from("sk_test_k:").toString("base64")}`, "sk_test_k")).toBe("Basic <key>");
  });
});

describe("HAR values", () => {
  it("keep id formats but not the recorded ids, numbers or free-form codes", () => {
    const har = { log: { entries: [{
      request: { method: "GET", url: "https://api.x.example/v1/accounts/acct_REALid998877", headers: [] },
      response: { status: 200, content: { mimeType: "application/json", text: JSON.stringify({ id: "acct_REALid998877", customer_id: "cus_REALcustomer42", amount: 987654, phone: 15551234567, vip: true, domain: "realcorp.example", status: "Active since March", type: "business", valid: "yes-really-valid-text" }) } },
    }] } };
    const { openapi } = harToOpenApi(har);
    const dump = JSON.stringify(openapi);
    for (const v of ["REALid998877", "REALcustomer42", "987654", "15551234567", "realcorp", "Active since March", "yes-really-valid-text"]) expect(dump).not.toContain(v);
    expect(dump).toContain("business");
    const id = synthId("acct_REALid998877");
    expect(id).toMatch(/^acct_[A-Z]{4}[a-z]{2}\d{6}$/);
    expect(synthId("3f2b1c9a-0000-4000-8000-1234567890ab")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
