/**
 * Fidelity check: run the same scripted calls against a twin and against the real provider's sandbox (with the user's
 * own test key), then compare status codes, field names, field types, id formats and error codes.
 *
 * The report never contains response data: only field paths, types, id shapes and short code values
 * (`object`, `type`, `code`, `status`). It is safe to publish.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, packsDir } from "../engine/load.js";
import { safeMatch } from "../engine/template.js";
import { serveTwin } from "../engine/server.js";
import type { TwinDefinition } from "../engine/types.js";
import { isLoopbackUrl } from "../engine/util.js";
import { safeFetch } from "../lib/safeFetch.js";

export interface SuiteStep {
  id: string;
  name?: string;
  method: string;
  /** `{{var}}` is replaced with values saved by earlier steps (separately for the twin and the real API). */
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: Record<string, unknown>;
  /** Send the request without credentials (checks the unauthorized error). */
  noAuth?: boolean;
  /** `var: dot.path` saved from the response, e.g. `customer: id` or `ref: data.reference`. */
  save?: Record<string, string>;
  /** Field paths not compared (fields that differ by design, e.g. account-specific settings). */
  ignore?: string[];
}

export interface Suite {
  schema: 1;
  twin: string;
  title: string;
  realBaseUrl: string;
  /** Regex the sandbox key must match (positive proof it is a test key). */
  testKey?: string;
  /** Key the twin is called with. */
  twinKey?: string;
  encoding?: "json" | "form";
  headers?: Record<string, string>;
  steps: SuiteStep[];
  /** Run after the steps (both sides) to tidy the sandbox; not scored. */
  cleanup?: SuiteStep[];
  /** Field paths ignored in every step. */
  ignore?: string[];
  notes?: string[];
}

export interface StepResult {
  id: string; name: string; method: string; path: string;
  status: { twin: number | null; real: number | null };
  score: number;
  missing: string[]; extra: string[]; typeDiffs: string[]; valueDiffs: string[];
  error?: string;
}

export interface FidelityReport {
  mockanything: 1;
  twin: string;
  title: string;
  suite: string;
  against: string;
  measuredAt: string;
  score: number;
  calls: number;
  steps: StepResult[];
  summary: { status: number; fields: number; types: number; values: number };
  limitations: string[];
}

export interface VerifyOptions {
  key: string;
  /** Override the real base URL (another sandbox host, a staging server, or a twin on this machine in tests). */
  against?: string;
  paceMs?: number;
  maxCalls?: number;
  fetchTimeoutMs?: number;
  onStep?: (r: StepResult) => void;
}

const VALUE_KEYS = new Set(["object", "type", "code", "status", "decline_code", "currency", "livemode", "deleted", "has_more"]);
const LIVE_KEY = [/^(sk|rk|pk)_live_/, /^rzp_live_/, /_live_/i, /^live_/i];
const MAX_DEPTH = 5;

export function suitePath(twinId: string): string { return join(packsDir(), "verify", `${twinId}.yaml`); }

export function loadSuite(pathOrId: string): Suite {
  const p = existsSync(pathOrId) ? pathOrId : suitePath(pathOrId);
  if (!existsSync(p)) throw new Error(`No verify suite for "${pathOrId}". Built-in suites: ${builtInSuites().join(", ") || "none"}. Write one (see packs/verify/) and pass --suite <file>, or use --against <base-url> to check the read-only list calls.`);
  const s = parseDocument(readFileSync(p, "utf8"), p) as Suite;
  if (!s || s.schema !== 1 || typeof s.twin !== "string" || !Array.isArray(s.steps) || !s.steps.length) throw new Error(`${p} is not a verify suite`);
  for (const st of [...s.steps, ...(s.cleanup ?? [])]) {
    if (typeof st.method !== "string" || typeof st.path !== "string" || !st.path.startsWith("/")) throw new Error(`${p}: every step needs a method and a path starting with /`);
  }
  return s;
}

export function builtInSuites(): string[] {
  try { return readdirSync(join(packsDir(), "verify")).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, "")).sort(); }
  catch { return []; }
}

/** Hosts the built-in suites call: the providers' own API hosts. */
export function officialHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const id of builtInSuites()) {
    try { hosts.add(new URL(loadSuite(id).realBaseUrl).host.toLowerCase()); } catch { /* skip */ }
  }
  return hosts;
}

/** Whether sending the key to this base URL needs the user's say-so (a host no built-in suite uses, and not this machine). */
export function needsKeyConfirm(baseUrl: string): boolean {
  if (isLoopbackUrl(baseUrl)) return false;
  try { return !officialHosts().has(new URL(baseUrl).host.toLowerCase()); } catch { return true; }
}

/** A read-only suite for any twin: its list calls, plus one lookup of an id that doesn't exist (the error shape). */
export function autoSuite(def: TwinDefinition, realBaseUrl: string): Suite {
  const steps: SuiteStep[] = [];
  for (const op of def.operations) {
    if (steps.length >= 8) break;
    if (op.method.toUpperCase() === "GET" && op.action === "list" && !op.path.includes("{")) {
      steps.push({ id: `list_${op.resource ?? steps.length}`, name: `List ${op.resource}`, method: "GET", path: `${def.basePath ?? ""}${op.path}` });
    }
  }
  const read = def.operations.find((o) => o.method.toUpperCase() === "GET" && o.action === "read" && (o.path.match(/\{/g) ?? []).length === 1);
  if (read) steps.push({ id: "missing", name: `Read a ${read.resource} that doesn't exist`, method: "GET", path: `${def.basePath ?? ""}${read.path.replace(/\{[^}]+\}/, "mockanything_missing_0000")}` });
  if (!steps.length) throw new Error(`${def.title} has no list calls to check automatically. Write a suite and pass --suite <file>.`);
  return { schema: 1, twin: def.id, title: `${def.title} read-only check`, realBaseUrl, steps, notes: ["Automatic suite: list calls and one not-found error only."] };
}

export function assertTestKey(key: string, def: TwinDefinition, suite: Suite): void {
  if (!key) throw new Error("A sandbox (test-mode) key is required: --key <test key> or MOCKANYTHING_SANDBOX_KEY.");
  const live = LIVE_KEY.some((r) => r.test(key)) || (def.auth.livePattern ? safeMatch(def.auth.livePattern, key) : false);
  if (live) throw new Error("That looks like a live key. verify only runs with test-mode keys, so nothing real is charged, sent or changed.");
  if (suite.testKey && !safeMatch(suite.testKey, key)) throw new Error(`That doesn't look like a ${def.title} test key (expected /${suite.testKey}/). verify only runs with test-mode keys.`);
}

// ---------- comparison ----------

type Shape = Map<string, string>;
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? "number" : typeof v);

function flatten(v: unknown, prefix = "", out: Shape = new Map(), values = new Map<string, unknown>(), depth = 0): { shape: Shape; values: Map<string, unknown> } {
  if (depth > MAX_DEPTH) return { shape: out, values };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.set(p, typeOf(x));
      values.set(p, x);
      if (x && typeof x === "object") flatten(Array.isArray(x) ? x[0] : x, Array.isArray(x) ? `${p}[]` : p, out, values, depth + 1);
    }
  }
  return { shape: out, values };
}

/** `cus_[a-zA-Z0-9]{14}` style: prefix + character classes + length. */
export function idShape(s: string): string {
  const m = s.match(/^([A-Za-z]+_)?(.*)$/)!;
  const rest = m[2] ?? "";
  const cls = /^[0-9]+$/.test(rest) ? "0-9" : /^[0-9a-f-]+$/.test(rest) ? "hex" : /^[A-Z0-9]+$/.test(rest) ? "A-Z0-9" : /^[a-z0-9]+$/.test(rest) ? "a-z0-9" : "mixed";
  return `${m[1] ?? ""}[${cls}]{${rest.length}}`;
}
function idsAlike(a: string, b: string): boolean {
  const pa = a.match(/^([A-Za-z]+_)/)?.[1] ?? "", pb = b.match(/^([A-Za-z]+_)/)?.[1] ?? "";
  return pa === pb && Math.abs(a.length - b.length) <= 8;
}
const isIdKey = (path: string) => { const k = path.split(".").pop()!.replace("[]", ""); return k === "id" || k.endsWith("_id") || k.endsWith("_code") || k === "reference"; };
const ignored = (path: string, globs: string[]) => globs.some((g) => g === path || (g.endsWith(".*") && path.startsWith(g.slice(0, -1))) || (g.startsWith("*.") && path.endsWith(g.slice(1))));

export function compareBodies(twin: unknown, real: unknown, ignore: string[] = []): Pick<StepResult, "missing" | "extra" | "typeDiffs" | "valueDiffs"> & { fields: number; types: number; values: number } {
  const t = flatten(twin), r = flatten(real);
  const keep = (p: string) => !ignored(p, ignore);
  const tk = [...t.shape.keys()].filter(keep), rk = [...r.shape.keys()].filter(keep);
  const both = rk.filter((k) => t.shape.has(k));
  const missing = rk.filter((k) => !t.shape.has(k)).sort();
  const extra = tk.filter((k) => !r.shape.has(k)).sort();
  const union = new Set([...tk, ...rk]).size;
  const typeDiffs: string[] = [];
  let typed = 0, typeOk = 0;
  for (const k of both) {
    const a = t.shape.get(k)!, b = r.shape.get(k)!;
    if (a === "null" || b === "null") continue;
    typed++;
    if (a === b) typeOk++; else typeDiffs.push(`${k}: twin ${a}, real ${b}`);
  }
  const valueDiffs: string[] = [];
  let valued = 0, valueOk = 0;
  for (const k of both) {
    const a = t.values.get(k), b = r.values.get(k);
    const last = k.split(".").pop()!.replace("[]", "");
    if (typeof a === "string" && typeof b === "string" && isIdKey(k)) {
      valued++;
      if (idsAlike(a, b)) valueOk++; else valueDiffs.push(`${k} id format: twin ${idShape(a)}, real ${idShape(b)}`);
    } else if (VALUE_KEYS.has(last) && (typeof b === "string" || typeof b === "boolean" || typeof b === "number") && b !== null) {
      valued++;
      if (a === b) valueOk++; else valueDiffs.push(`${k}: twin ${short(a)}, real ${short(b)}`);
    }
  }
  return {
    missing, extra, typeDiffs, valueDiffs,
    fields: union ? both.length / union : 1,
    types: typed ? typeOk / typed : 1,
    values: valued ? valueOk / valued : 1,
  };
}
const short = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.slice(0, 60)) : JSON.stringify(v));

// ---------- running ----------

interface Target { name: "twin" | "real"; base: string; key: string; vars: Record<string, string>; real: boolean }

function fillVars(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, k: string) => encodeURIComponent(vars[k] ?? `missing_${k}`));
}
function fillDeep(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === "string") return v.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? `missing_${k}`);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, vars)]));
  return v;
}
function formEncode(v: unknown, prefix = "", out = new URLSearchParams()): URLSearchParams {
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) formEncode(x, prefix ? `${prefix}[${k}]` : k, out);
  else if (Array.isArray(v)) v.forEach((x, i) => formEncode(x, `${prefix}[${i}]`, out));
  else if (v !== undefined && v !== null) out.append(prefix, String(v));
  return out;
}
function pick(v: unknown, path: string): unknown {
  let cur = v;
  for (const p of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(p) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
  }
  return cur;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authHeaders(def: TwinDefinition, key: string): { headers: Record<string, string>; query?: [string, string] } {
  const a = def.auth;
  if (a.type === "basic") return { headers: { authorization: `Basic ${Buffer.from(key.includes(":") ? key : `${key}:`).toString("base64")}` } };
  if (a.type === "header") return { headers: { [a.name ?? "x-api-key"]: key } };
  if (a.type === "query") return { headers: {}, query: [a.name ?? "api_key", key] };
  if (a.type === "none") return { headers: {} };
  return { headers: { authorization: `Bearer ${key}` } };
}

/** Remove every form of the key (as typed, URL-encoded, Basic-auth Base64) from a message. */
export function redactKey(message: string, key: string): string {
  if (!key) return message;
  const forms = [key, encodeURIComponent(key), Buffer.from(key.includes(":") ? key : `${key}:`).toString("base64"), Buffer.from(key).toString("base64")];
  let out = message;
  for (const f of [...new Set(forms)].sort((a, b) => b.length - a.length)) if (f) out = out.replaceAll(f, "<key>");
  return out;
}

export async function runVerify(def: TwinDefinition, suite: Suite, opts: VerifyOptions): Promise<FidelityReport> {
  assertTestKey(opts.key, def, suite);
  const against = (opts.against ?? suite.realBaseUrl).replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(against); } catch { throw new Error(`Not a URL: ${against}`); }
  const local = isLoopbackUrl(against);
  if (!local && u.protocol !== "https:") throw new Error("The real API must be reached over https.");
  const paceMs = local ? (opts.paceMs ?? 0) : Math.max(200, opts.paceMs ?? 1000);
  const maxCalls = Math.min(100, Math.max(1, opts.maxCalls ?? 60));
  const steps = [...suite.steps];
  const total = steps.length + (suite.cleanup?.length ?? 0);
  if (total > maxCalls) throw new Error(`This suite makes ${total} calls to the real API, more than the limit of ${maxCalls} (--max-calls).`);

  const running = await serveTwin(def, { port: 0 });
  const twinT: Target = { name: "twin", base: running.url, key: suite.twinKey ?? "sk_test_mockanything", vars: {}, real: false };
  const realT: Target = { name: "real", base: against, key: opts.key, vars: {}, real: !local };
  let calls = 0;
  let lastReal = 0;

  const call = async (t: Target, st: SuiteStep): Promise<{ status: number | null; body: unknown; error?: string }> => {
    const url = new URL(t.base + fillVars(st.path, t.vars));
    for (const [k, v] of Object.entries(st.query ?? {})) url.searchParams.set(k, fillVars(String(v), t.vars));
    const auth = st.noAuth ? { headers: {} as Record<string, string> } : authHeaders(def, t.key);
    if (auth.query) url.searchParams.set(auth.query[0], auth.query[1]);
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "mockanything-verify (+https://shipatmidnight.dev/mockanything)", ...suite.headers, ...auth.headers };
    let body: string | undefined;
    if (st.body && st.method.toUpperCase() !== "GET") {
      const filled = fillDeep(st.body, t.vars);
      if ((suite.encoding ?? "json") === "form") { body = formEncode(filled).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; }
      else { body = JSON.stringify(filled); headers["content-type"] = "application/json"; }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (t === realT) {
        const wait = lastReal + paceMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastReal = Date.now();
        calls++;
      }
      try {
        const init = { method: st.method.toUpperCase(), headers, body };
        let status: number, text: string, retryAfter: string | null;
        if (t.real) {
          // no redirects: the key is only ever sent to the host you named
          const r = await safeFetch(url, init, { maxBytes: 5 * 1024 * 1024, timeoutMs: opts.fetchTimeoutMs ?? 20_000, maxRedirects: 0, httpsOnly: true });
          status = r.status; text = await r.text(); retryAfter = r.headers.get("retry-after") as string | null;
        } else {
          const r = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.fetchTimeoutMs ?? 20_000) });
          status = r.status; text = await r.text(); retryAfter = r.headers.get("retry-after");
        }
        if (status === 429 && attempt === 0 && t === realT) { await sleep(Math.min(10_000, (Number(retryAfter) || 2) * 1000)); continue; }
        let parsed: unknown = undefined;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
        for (const [k, p] of Object.entries(st.save ?? {})) { const v = pick(parsed, p); if (v !== undefined && v !== null) t.vars[k] = String(v); }
        return { status, body: parsed };
      } catch (e) {
        return { status: null, body: undefined, error: redactKey((e as Error).message, opts.key) };
      }
    }
    return { status: 429, body: undefined };
  };

  const results: StepResult[] = [];
  try {
    for (const st of steps) {
      const [tw, re] = [await call(twinT, st), await call(realT, st)];
      const ignore = [...(suite.ignore ?? []), ...(st.ignore ?? [])];
      const cmp = tw.body !== undefined || re.body !== undefined ? compareBodies(tw.body, re.body, ignore) : { missing: [], extra: [], typeDiffs: [], valueDiffs: [], fields: 1, types: 1, values: 1 };
      const statusOk = tw.status !== null && tw.status === re.status ? 1 : 0;
      const score = re.status === null ? 0 : statusOk * 0.4 + cmp.fields * 0.3 + cmp.types * 0.15 + cmp.values * 0.15;
      const r: StepResult = {
        id: st.id, name: st.name ?? st.id, method: st.method.toUpperCase(), path: st.path,
        status: { twin: tw.status, real: re.status }, score: Math.round(score * 1000) / 10,
        missing: cmp.missing.slice(0, 40), extra: cmp.extra.slice(0, 40), typeDiffs: cmp.typeDiffs.slice(0, 40), valueDiffs: cmp.valueDiffs.slice(0, 40),
        ...(re.error || tw.error ? { error: re.error ? `real: ${re.error}` : `twin: ${tw.error}` } : {}),
        _parts: { status: statusOk, fields: cmp.fields, types: cmp.types, values: cmp.values },
      } as StepResult & { _parts: Record<string, number> };
      results.push(r);
      opts.onStep?.(stripParts(r));
    }
    for (const st of suite.cleanup ?? []) { await call(twinT, st); await call(realT, st); }
  } finally {
    await running.close();
  }

  const parts = results.map((r) => (r as StepResult & { _parts: Record<string, number> })._parts);
  const avg = (k: string) => (parts.length ? parts.reduce((s, p) => s + p[k]!, 0) / parts.length : 0);
  const score = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
  return {
    mockanything: 1, twin: def.id, title: def.title, suite: suite.title, against: local ? "a server on this machine" : u.host,
    measuredAt: new Date().toISOString(), score: Math.round(score * 10) / 10, calls,
    steps: results.map(stripParts),
    summary: { status: pct(avg("status")), fields: pct(avg("fields")), types: pct(avg("types")), values: pct(avg("values")) },
    limitations: [
      "Webhooks are not compared (the real API would need a public URL to deliver to).",
      "Compares response shapes, types, id formats and code values, not every value.",
      "Measured with one account's sandbox; account settings and API versions can change some fields.",
      ...(suite.notes ?? []),
    ],
  };
}
const pct = (x: number) => Math.round(x * 1000) / 10;
function stripParts(r: StepResult): StepResult { const { _parts: _p, ...rest } = r as StepResult & { _parts?: unknown }; return rest; }

export function reportMarkdown(r: FidelityReport): string {
  const lines = [
    `# ${r.title} twin fidelity: ${r.score}%`,
    "",
    `Measured ${r.measuredAt.slice(0, 10)} against ${r.against} (${r.suite}: ${r.steps.length} checks, ${r.calls} calls to the real API).`,
    "",
    `| Status codes | Fields | Types | Ids and codes |`,
    `|---|---|---|---|`,
    `| ${r.summary.status}% | ${r.summary.fields}% | ${r.summary.types}% | ${r.summary.values}% |`,
    "",
    "| Check | Twin | Real | Score |",
    "|---|---|---|---|",
    ...r.steps.map((s) => `| ${s.name} | ${s.status.twin ?? "error"} | ${s.status.real ?? "error"} | ${s.score}% |`),
    "",
  ];
  const diffs = r.steps.filter((s) => s.missing.length || s.extra.length || s.typeDiffs.length || s.valueDiffs.length || s.error);
  if (diffs.length) {
    lines.push("## Differences", "");
    for (const s of diffs) {
      lines.push(`### ${s.name}`);
      if (s.error) lines.push(`- ${s.error}`);
      if (s.missing.length) lines.push(`- Missing in the twin: ${s.missing.map((x) => `\`${x}\``).join(", ")}`);
      if (s.extra.length) lines.push(`- Only in the twin: ${s.extra.map((x) => `\`${x}\``).join(", ")}`);
      for (const d of [...s.typeDiffs, ...s.valueDiffs]) lines.push(`- ${d}`);
      lines.push("");
    }
  }
  lines.push("## Limitations", "", ...r.limitations.map((l) => `- ${l}`), "");
  return lines.join("\n");
}
