/**
 * HAR recording → OpenAPI 3 description → the normal inference.
 *
 * Privacy: no values from the recording are copied. Header values, cookies, query values, free text, numbers and
 * booleans are dropped. Kept: field names and types, id formats (as made-up ids with the same prefix and length) and
 * short status/type codes (for lifecycles). Emails, URLs and dates become formats, so the twin invents its own values.
 */
import { randomBytes } from "node:crypto";
import { singularize } from "../engine/util.js";

const MAX_ENTRIES = 5000;
const MAX_BODY = 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_PROPS = 200;
const STATE_KEYS = new Set(["status", "state", "phase", "lifecycle_state"]);
const KEEP_STRING_KEYS = new Set(["object", "type", "kind", "currency", "method", "channel", "livemode", "mode", "gateway"]);
/** Codes like `pending`, `card`, `usd`; anything longer or with spaces is treated as data. */
const CODE = /^[A-Za-z0-9_.-]{1,40}$/;
const isIdKey = (key: string) => /(^|_)id$/i.test(key) || /[a-z0-9]Id$/.test(key);

/** A made-up id with the same prefix, length and character classes as a recorded one. */
export function synthId(real: string): string {
  const m = /^([A-Za-z]{1,12}_)?(.*)$/s.exec(real.slice(0, 120))!;
  const rest = m[2] ?? "";
  const hex = /^[0-9a-fA-F-]+$/.test(rest);
  const bytes = randomBytes(rest.length);
  let out = "";
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!, b = bytes[i]!;
    if (/[0-9]/.test(ch)) out += String(b % 10);
    else if (/[a-z]/.test(ch)) out += (hex ? "abcdef" : "abcdefghijklmnopqrstuvwxyz")[b % (hex ? 6 : 26)];
    else if (/[A-Z]/.test(ch)) out += (hex ? "ABCDEF" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ")[b % (hex ? 6 : 26)];
    else out += ch;
  }
  return (m[1] ?? "") + out;
}
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

type Schema = Record<string, unknown>;

interface Entry {
  method: string;
  origin: string;
  host: string;
  path: string;
  query: string[];
  status: number;
  req?: { kind: "json" | "form"; value: unknown };
  res?: unknown;
  auth?: { type: "bearer" } | { type: "basic" } | { type: "header"; name: string } | { type: "query"; name: string };
}

export interface HarSummary { entries: number; used: number; skipped: number; host: string; operations: number }

export function isHar(doc: unknown): boolean {
  const log = doc && typeof doc === "object" ? (doc as Record<string, unknown>).log : undefined;
  return !!log && typeof log === "object" && Array.isArray((log as Record<string, unknown>).entries);
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_BODY) return undefined;
  try { return JSON.parse(text, (k, v) => (k === "__proto__" || k === "constructor" ? undefined : v)); } catch { return undefined; }
}

function bodyText(content: Record<string, unknown> | undefined): string | undefined {
  if (!content || typeof content.text !== "string") return undefined;
  if (content.encoding === "base64") {
    try { return Buffer.from(content.text, "base64").toString("utf8"); } catch { return undefined; }
  }
  return content.text;
}

const AUTH_HEADERS = ["x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token", "x-api-token", "private-token"];
const AUTH_QUERY = ["api_key", "apikey", "key", "access_token", "token"];

function readEntries(doc: unknown): { entries: Entry[]; total: number } {
  const raw = ((doc as { log: { entries: unknown[] } }).log.entries ?? []).slice(0, MAX_ENTRIES);
  const entries: Entry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const req = (e as Record<string, unknown>).request as Record<string, unknown> | undefined;
    const res = (e as Record<string, unknown>).response as Record<string, unknown> | undefined;
    if (!req || !res || typeof req.url !== "string") continue;
    const method = String(req.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) continue;
    let url: URL;
    try { url = new URL(req.url); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const status = Number(res.status);
    if (!Number.isInteger(status) || status < 200 || status >= 600 || (status >= 300 && status < 400)) continue;
    const content = res.content as Record<string, unknown> | undefined;
    const mime = String(content?.mimeType ?? "").toLowerCase();
    const text = bodyText(content);
    const resJson = parseJson(text);
    // API traffic only: JSON bodies, or empty bodies (204, deletes)
    if (resJson === undefined && text && text.trim() && !mime.includes("json")) continue;
    if (/\.(js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|html?)$/i.test(url.pathname)) continue;

    const headers = Array.isArray(req.headers) ? (req.headers as { name?: string; value?: string }[]) : [];
    const h = (n: string) => headers.find((x) => String(x.name ?? "").toLowerCase() === n)?.value;
    let auth: Entry["auth"];
    const authz = h("authorization");
    if (authz && /^bearer\s/i.test(authz)) auth = { type: "bearer" };
    else if (authz && /^basic\s/i.test(authz)) auth = { type: "basic" };
    else if (authz) auth = { type: "bearer" };
    else {
      const name = AUTH_HEADERS.find((n) => h(n) !== undefined);
      if (name) auth = { type: "header", name };
      else { const q = AUTH_QUERY.find((n) => url.searchParams.has(n)); if (q) auth = { type: "query", name: q }; }
    }

    let reqBody: Entry["req"];
    const post = req.postData as Record<string, unknown> | undefined;
    if (post) {
      const pmime = String(post.mimeType ?? "").toLowerCase();
      if (pmime.includes("json")) { const v = parseJson(post.text); if (v !== undefined) reqBody = { kind: "json", value: v }; }
      else if (pmime.includes("x-www-form-urlencoded")) {
        const obj: Record<string, string> = {};
        if (Array.isArray(post.params)) for (const p of post.params as { name?: string; value?: string }[]) { if (p.name) obj[p.name] = String(p.value ?? ""); }
        else if (typeof post.text === "string") for (const [k, v] of new URLSearchParams(post.text)) obj[k] = v;
        reqBody = { kind: "form", value: obj };
      }
    }
    entries.push({
      method, origin: url.origin, host: url.host, path: url.pathname.replace(/\/+$/, "") || "/",
      query: [...new Set([...url.searchParams.keys()].filter((k) => !AUTH_QUERY.includes(k)))],
      status, req: reqBody, res: resJson, auth,
    });
  }
  return { entries, total: raw.length };
}

function collectIds(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > MAX_DEPTH || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 100)) collectIds(x, out, depth + 1); return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if ((k === "id" || /_id$|Id$/.test(k) || k === "number" || k === "uuid" || k === "reference") && (typeof x === "string" || typeof x === "number")) out.add(String(x));
    else collectIds(x, out, depth + 1);
  }
}

function idLike(seg: string, known: Set<string>): boolean {
  if (known.has(seg)) return true;
  return /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
    || /^[0-9a-f]{16,}$/i.test(seg) || /^[A-Za-z]{1,12}_[A-Za-z0-9]{6,}$/.test(seg)
    || (seg.length >= 12 && /\d/.test(seg) && /[a-z]/i.test(seg) && !/[-_.]/.test(seg));
}

function template(path: string, known: Set<string>): { path: string; params: string[] } {
  const segs = path.split("/").filter(Boolean);
  const params: string[] = [];
  const out = segs.map((s, i) => {
    if (!idLike(decodeURIComponent(s), known)) return s;
    const prev = segs[i - 1];
    let name = i === segs.length - 1 ? "id" : prev && !idLike(prev, known) ? `${singularize(prev).replace(/[^A-Za-z0-9_]/g, "_")}_id` : `p${i}`;
    while (params.includes(name)) name = `${name}_${i}`;
    params.push(name);
    return `{${name}}`;
  });
  return { path: `/${out.join("/")}`, params };
}

const isoDate = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Status-like values seen anywhere for one resource, so every response shares the full lifecycle. */
type StateValues = Map<string, string[]>;

function gatherStates(v: unknown, out: StateValues, depth = 0): void {
  if (depth > MAX_DEPTH || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 100)) gatherStates(x, out, depth + 1); return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (STATE_KEYS.has(k.toLowerCase()) && typeof x === "string") {
      const list = out.get(k.toLowerCase()) ?? [];
      if (!list.includes(x) && list.length < 30) list.push(x);
      out.set(k.toLowerCase(), list);
    } else gatherStates(x, out, depth + 1);
  }
}

function schemaOf(values: unknown[], key: string, depth = 0, states?: StateValues): Schema {
  const vals = values.filter((v) => v !== undefined);
  const nonNull = vals.filter((v) => v !== null);
  if (!nonNull.length) return { nullable: true };
  const kind = (v: unknown) => (Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
  const counts = new Map<string, number>();
  for (const v of nonNull) counts.set(kind(v), (counts.get(kind(v)) ?? 0) + 1);
  let t = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  if (t === "integer" && counts.has("number")) t = "number";
  const same = nonNull.filter((v) => kind(v) === t || (t === "number" && kind(v) === "integer"));
  const s: Schema = {};
  if (nonNull.length < vals.length) s.nullable = true;
  if (depth > MAX_DEPTH) return { ...s, type: t === "array" ? "array" : t === "object" ? "object" : t };
  switch (t) {
    case "object": {
      s.type = "object";
      const keys: string[] = [];
      for (const o of same as Record<string, unknown>[]) for (const k of Object.keys(o)) if (!keys.includes(k) && keys.length < MAX_PROPS) keys.push(k);
      const props: Record<string, Schema> = {};
      for (const k of keys) props[k] = schemaOf((same as Record<string, unknown>[]).map((o) => o[k]), k, depth + 1, states);
      s.properties = props;
      return s;
    }
    case "array": {
      s.type = "array";
      s.items = schemaOf((same as unknown[][]).flatMap((a) => a.slice(0, 50)), singularize(key), depth + 1, states);
      return s;
    }
    case "string": {
      s.type = "string";
      const strs = same as string[];
      const k = key.toLowerCase();
      if (STATE_KEYS.has(k)) {
        const distinct = [...new Set([...strs, ...(states?.get(k) ?? [])])].filter((x) => CODE.test(x)).slice(0, 30);
        if (distinct.length) { s.enum = distinct; s.example = distinct[0]; }
        return s;
      }
      if (strs.every((x) => isoDate.test(x))) { s.format = strs[0]!.includes("T") ? "date-time" : "date"; return s; }
      if (strs.every((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) { s.format = "email"; return s; }
      if (strs.every((x) => /^https?:\/\//i.test(x))) { s.format = "uri"; return s; }
      if (isIdKey(key)) { s.example = synthId(strs[0]!); return s; }
      if (KEEP_STRING_KEYS.has(k) && CODE.test(strs[0]!)) { s.example = strs[0]; return s; }
      return s;
    }
    case "integer": case "number": s.type = t; return s;
    case "boolean": s.type = "boolean"; return s;
    default: return s;
  }
}

/** Build an OpenAPI 3.0 description from a HAR recording. */
export function harToOpenApi(doc: unknown, name = "recording"): { openapi: Record<string, unknown>; summary: HarSummary; notes: string[] } {
  const { entries: all, total } = readEntries(doc);
  if (!all.length) throw new Error(`${name} has no JSON API requests (only pages, scripts or images). Record while your app calls the API, then save the HAR again.`);
  const byOrigin = new Map<string, number>();
  for (const e of all) byOrigin.set(e.origin, (byOrigin.get(e.origin) ?? 0) + 1);
  const origin = [...byOrigin.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const entries = all.filter((e) => e.origin === origin);
  const notes: string[] = [];
  if (byOrigin.size > 1) notes.push(`Used ${entries.length} requests to ${new URL(origin).host}; ignored ${all.length - entries.length} to ${byOrigin.size - 1} other host(s).`);

  const known = new Set<string>();
  for (const e of entries) { collectIds(e.res, known); collectIds(e.req?.value, known); }

  // base path: shared leading version-ish segments (/v1, /api, /api/v2)
  const segLists = entries.map((e) => e.path.split("/").filter(Boolean));
  const base: string[] = [];
  for (let i = 0; i < 3; i++) {
    const s = segLists[0]?.[i];
    if (!s || !/^(v\d+(\.\d+)?|api|rest|public)$/i.test(s) || !segLists.every((l) => l[i] === s && l.length > i + 1)) break;
    base.push(s);
  }
  const strip = (p: string) => (base.length ? p.split("/").filter(Boolean).slice(base.length).join("/") : p.replace(/^\//, ""));

  type Group = { method: string; path: string; params: string[]; byStatus: Map<number, unknown[]>; reqs: Entry["req"][]; query: Set<string>; resource: string };
  const statesBy = new Map<string, StateValues>();
  // `/orders/{id}/cancel` → orders; `/repos/{owner}/{repo}/issues/{id}` → issues (a trailing verb after an id is an action)
  const resourceOf = (templated: string) => {
    const segs = templated.split("/").filter(Boolean);
    if (segs.length >= 2 && !segs.at(-1)!.startsWith("{") && segs.at(-2)!.startsWith("{")) segs.pop();
    return [...segs].reverse().find((x) => !x.startsWith("{")) ?? "";
  };
  const groups = new Map<string, Group>();
  for (const e of entries) {
    const t = template(`/${strip(e.path)}`, known);
    const key = `${e.method} ${t.path}`;
    let g = groups.get(key);
    if (!g) { g = { method: e.method, path: t.path, params: t.params, byStatus: new Map(), reqs: [], query: new Set(), resource: resourceOf(t.path) }; groups.set(key, g); }
    const sv = statesBy.get(g.resource) ?? new Map();
    if (e.status < 300) gatherStates(e.res, sv);
    statesBy.set(g.resource, sv);
    const list = g.byStatus.get(e.status) ?? [];
    list.push(e.res);
    g.byStatus.set(e.status, list);
    if (e.req) g.reqs.push(e.req);
    for (const q of e.query) g.query.add(q);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const g of groups.values()) {
    const states = statesBy.get(g.resource);
    const responses: Record<string, unknown> = {};
    for (const [status, bodies] of [...g.byStatus.entries()].sort((a, b) => a[0] - b[0])) {
      const present = bodies.filter((b) => b !== undefined);
      responses[String(status)] = present.length
        ? { description: `Recorded ${status}`, content: { "application/json": { schema: schemaOf(present, "body", 0, states) } } }
        : { description: `Recorded ${status}` };
    }
    const op: Record<string, unknown> = { responses };
    const parameters: Record<string, unknown>[] = g.params.map((p) => ({ name: p, in: "path", required: true, schema: { type: "string" } }));
    for (const q of [...g.query].slice(0, 40)) parameters.push({ name: q, in: "query", required: false, schema: { type: "string" } });
    if (parameters.length) op.parameters = parameters;
    const json = g.reqs.filter((r) => r?.kind === "json").map((r) => r!.value);
    const form = g.reqs.filter((r) => r?.kind === "form").map((r) => r!.value);
    if (json.length || form.length) {
      op.requestBody = {
        content: json.length >= form.length
          ? { "application/json": { schema: schemaOf(json, "body") } }
          : { "application/x-www-form-urlencoded": { schema: schemaOf(form, "body") } },
      };
    }
    (paths[g.path] ??= {})[g.method.toLowerCase()] = op;
  }

  const authCounts = new Map<string, { n: number; a: NonNullable<Entry["auth"]> }>();
  for (const e of entries) if (e.auth) { const k = JSON.stringify(e.auth); const c = authCounts.get(k); authCounts.set(k, { n: (c?.n ?? 0) + 1, a: e.auth }); }
  const auth = [...authCounts.values()].sort((a, b) => b.n - a.n)[0]?.a;
  const securitySchemes: Record<string, unknown> = {};
  if (auth?.type === "bearer") securitySchemes.recorded = { type: "http", scheme: "bearer" };
  else if (auth?.type === "basic") securitySchemes.recorded = { type: "http", scheme: "basic" };
  else if (auth?.type === "header") securitySchemes.recorded = { type: "apiKey", in: "header", name: auth.name };
  else if (auth?.type === "query") securitySchemes.recorded = { type: "apiKey", in: "query", name: auth.name };

  const host = new URL(origin).host;
  const openapi: Record<string, unknown> = {
    openapi: "3.0.3",
    info: { title: host, description: `Recorded traffic to ${host}.` },
    servers: [{ url: `/${base.join("/")}` }],
    paths,
    components: Object.keys(securitySchemes).length ? { securitySchemes } : {},
    ...(Object.keys(securitySchemes).length ? { security: [{ recorded: [] }] } : {}),
  };
  return { openapi, summary: { entries: total, used: entries.length, skipped: total - entries.length, host, operations: groups.size }, notes };
}
