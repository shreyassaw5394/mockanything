/**
 * Coverage across the public APIs.guru directory: for a sample of APIs, build a twin from the published spec,
 * start it, create one object, read it back and list. Prints how many work and the commonest failures.
 *
 *   npx tsx scripts/coverage.ts [count=300] [--out coverage-out]
 *
 * Specs are downloaded on this machine from their original hosts and cached (never bundled or re-hosted).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "../src/engine/load.js";
import { ingestOpenApi } from "../src/ingest/openapi.js";
import { cachedText } from "../src/ingest/resolve.js";
import { serveTwin } from "../src/engine/server.js";
import type { Json, OperationDef, TwinDefinition } from "../src/engine/types.js";

const args = process.argv.slice(2);
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 300);
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1]! : "coverage-out";
const DAY = 86_400_000;

type Outcome = "ok" | "server_errors" | "ingest_failed" | "fetch_failed" | "boot_failed" | "no_resources" | "timeout";
interface Row { api: string; outcome: Outcome; detail?: string; resources?: number; operations?: number; ms?: number; ops?: number; answered?: number; success?: number }

const fill = (t: string | undefined): Json => (t === "integer" || t === "number" ? 1 : t === "boolean" ? true : t === "array" ? [] : t === "object" ? {} : "x");
const withParams = (path: string, id?: string) => path.replace(/\{([^}]+)\}/g, (_m, _p, off: number, s: string) => (id !== undefined && s.lastIndexOf("{") === off ? encodeURIComponent(id) : "acme"));

function findId(v: unknown, field: string, depth = 0): string | undefined {
  if (!v || typeof v !== "object" || depth > 4) return undefined;
  const o = v as Record<string, unknown>;
  if (o[field] !== undefined && o[field] !== null && typeof o[field] !== "object") return String(o[field]);
  for (const x of Object.values(o)) { const r = findId(Array.isArray(x) ? x[0] : x, field, depth + 1); if (r) return r; }
  return undefined;
}

const fourxx = new Map<string, number>();
interface Exercise { outcome: Outcome; detail?: string; ops: number; answered: number; success: number }

/** Create objects first, then call every other operation (up to 40). "Answered": 2xx, or a 4xx with a JSON error body. */
async function exercise(def: TwinDefinition): Promise<Exercise> {
  const ops = [...def.operations].sort((a, b) => Number(b.action === "create") - Number(a.action === "create")).slice(0, 40);
  if (!ops.length) return { outcome: "no_resources", detail: "no operations", ops: 0, answered: 0, success: 0 };
  const t = await serveTwin(def, { port: 0 });
  const created = new Map<string, string>();
  let answered = 0, success = 0;
  const bad: string[] = [];
  try {
    const base = `${t.url}${def.basePath ?? ""}`;
    const headers = { authorization: "Bearer test_key", "x-api-key": "test_key", "content-type": "application/json" };
    for (const op of ops) {
      const res = op.resource ? def.resources[op.resource] : undefined;
      const body: Record<string, Json> = {};
      if (["create", "update", "static", "transition"].includes(op.action)) for (const f of res?.required ?? []) body[f] = fill(res?.types?.[f]);
      const id = op.resource ? created.get(op.resource) : undefined;
      const url = base + withParams(op.path, ["read", "update", "delete", "transition"].includes(op.action) ? id ?? "missing_0" : undefined);
      const method = op.method.toUpperCase();
      const r = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: unknown = undefined, jsonOk = text.trim() === "";
      try { json = text ? JSON.parse(text) : undefined; jsonOk = true; } catch { /* not json */ }
      if (r.status < 300) { success++; answered += jsonOk ? 1 : 0; if (!jsonOk) bad.push(`${method} ${op.path} → ${r.status} non-JSON`); }
      else if (r.status < 500 && jsonOk) {
        answered++;
        const msg = String((json as Record<string, unknown>)?.message ?? JSON.stringify(json)).replace(/'[^']*'/g, "'…'").replace(/[A-Za-z0-9_]{12,}/g, "…").slice(0, 70);
        const k = `${op.action} ${r.status} ${msg}`;
        fourxx.set(k, (fourxx.get(k) ?? 0) + 1);
      }
      else bad.push(`${method} ${op.path} → ${r.status} ${text.slice(0, 80)}`);
      if (op.action === "create" && r.status < 300 && op.resource && !created.has(op.resource)) {
        const idv = findId(json, res?.id?.field ?? def.conventions?.idField ?? "id");
        if (idv) created.set(op.resource, idv);
      }
    }
  } finally { await t.close(); }
  const outcome: Outcome = bad.length ? "server_errors" : "ok";
  return { outcome, detail: bad.slice(0, 3).join(" | ") || undefined, ops: ops.length, answered, success };
}

async function one(api: string, url: string): Promise<Row> {
  const started = Date.now();
  let text: string;
  try { text = await cachedText(url, 30 * DAY); } catch (e) { return { api, outcome: "fetch_failed", detail: (e as Error).message.slice(0, 160) }; }
  let def: TwinDefinition, ops = 0, resources = 0;
  try { const r = ingestOpenApi(parseDocument(text), url); def = r.def; ops = r.report.operations.total; resources = r.report.resources.length; }
  catch (e) { return { api, outcome: "ingest_failed", detail: (e as Error).message.slice(0, 200) }; }
  try {
    const r = await Promise.race([exercise(def), new Promise<Exercise>((res) => setTimeout(() => res({ outcome: "timeout", detail: "30s", ops: 0, answered: 0, success: 0 }), 30_000))]);
    return { api, ...r, resources, operations: ops, ms: Date.now() - started };
  } catch (e) { return { api, outcome: "boot_failed", detail: (e as Error).message.slice(0, 200), resources, operations: ops }; }
}

const officialMode = args.includes("--official");
let sample: { api: string; url?: string }[];
if (officialMode) {
  const { officialSpecs } = await import("../src/ingest/resolve.js");
  sample = officialSpecs().map((o) => ({ api: o.name, url: o.url }));
} else {
  const list = JSON.parse(await cachedText("https://api.apis.guru/v2/list.json", DAY)) as Record<string, { preferred: string; versions: Record<string, { swaggerUrl?: string }> }>;
  const keys = Object.keys(list).sort();
  const step = Math.max(1, Math.floor(keys.length / count));
  sample = keys.filter((_k, i) => i % step === 0).slice(0, count).map((k) => ({ api: k, url: list[k]!.versions[list[k]!.preferred]?.swaggerUrl }));
}
const rows: Row[] = [];
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < sample.length) {
    const k = sample[next++]!;
    const row = k.url ? await one(k.api, k.url) : { api: k.api, outcome: "fetch_failed" as Outcome, detail: "no spec URL" };
    rows.push(row);
    process.stdout.write(row.outcome === "ok" ? "." : row.outcome[0]!);
  }
}));
const by = new Map<Outcome, number>();
for (const r of rows) by.set(r.outcome, (by.get(r.outcome) ?? 0) + 1);
const tested = rows.filter((r) => r.outcome !== "fetch_failed").length;
const ok = by.get("ok") ?? 0;
const booted = rows.filter((r) => !["fetch_failed", "ingest_failed", "boot_failed", "timeout"].includes(r.outcome)).length;
const opsT = rows.reduce((a, r) => a + (r.ops ?? 0), 0), opsA = rows.reduce((a, r) => a + (r.answered ?? 0), 0), opsS = rows.reduce((a, r) => a + (r.success ?? 0), 0);
const pc = (a: number, b: number) => `${a}/${b} (${((a / Math.max(1, b)) * 100).toFixed(1)}%)`;
console.log(`\n\n${rows.length} APIs sampled, ${tested} specs downloaded.`);
console.log(`  twin starts:                         ${pc(booted, tested)}`);
console.log(`  every call answered (no 5xx):        ${pc(ok, tested)}`);
console.log(`  calls answered (2xx or JSON 4xx):    ${pc(opsA, opsT)}`);
console.log(`  calls that succeeded (2xx):          ${pc(opsS, opsT)}`);
console.log("\nCommonest 4xx answers:");
for (const [k, n] of [...fourxx.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${String(n).padStart(4)}  ${k}`);
for (const [o, n] of [...by.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${o.padEnd(16)} ${n}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "coverage.json"), JSON.stringify({ at: new Date().toISOString(), sampled: rows.length, tested, booted, ok, calls: { total: opsT, answered: opsA, succeeded: opsS }, rows: rows.sort((a, b) => a.api.localeCompare(b.api)) }, null, 2));
console.log(`\nDetails: ${join(outDir, "coverage.json")}`);
process.exit(0);
