import { randomUUID } from "node:crypto";
import { evalCondition, render, renderString, safeMatch, type EvalContext } from "./template.js";
import type {
  CheckoutDef, EmitDef, ErrorSpec, Json, OperationDef, ResourceDef, ScenarioDef, Template, TransitionDef, TwinDefinition,
} from "./types.js";
import {
  IdFactory, coerce, findRealCard, isLoopbackUrl, maskCards, maskHeaders, mulberry32, parseForm, plain, randomAlnum,
  randomHex, safeJsonParse, signHmacHex, signStripe, signSvix, signTwilio, singularize,
} from "./util.js";

export interface TwinRequest {
  method: string;
  /** Path without query string. */
  path: string;
  rawQuery?: string;
  headers: Record<string, string>;
  rawBody?: string;
}

export interface TwinResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
  /** Milliseconds the server should wait before answering (chaos, scenarios). */
  delayMs?: number;
}

export type ChaosMode = "timeout" | "5xx" | "slow" | "429" | "dup-webhooks" | "out-of-order";
export const ALL_CHAOS: ChaosMode[] = ["timeout", "5xx", "slow", "429", "dup-webhooks", "out-of-order"];

export interface ChaosConfig { modes: ChaosMode[]; rate: number; seed: number }

export interface TwinOptions {
  baseUrl: string;
  chaos?: ChaosConfig | null;
  webhookUrls?: string[];
  allowWebhookHosts?: string[];
  /** Fixed webhook secret (otherwise generated). */
  webhookSecret?: string;
  /** Timeout for a chaos `timeout` (ms). */
  timeoutMs?: number;
  /** Speed factor for automatic transitions (tests use small values). */
  autoScale?: number;
  fetchImpl?: typeof fetch;
}

export interface LoggedRequest {
  id: string; at: number; method: string; path: string; status: number; durationMs: number;
  operation?: string; scenario?: string; chaos?: string; warning?: string;
  requestHeaders: Record<string, string>; requestBody?: Json; responseBody?: Json;
}
export interface LoggedDelivery {
  id: string; at: number; type: string; url: string; status: number | null; attempt: number; error?: string;
  duplicate?: boolean; payload: Json;
}

interface Endpoint { id: string; url: string; events: string[]; secret: string }

export interface SavedState {
  mockanything: 1;
  twin: string;
  savedAt: string;
  store: Record<string, Record<string, Json>[]>;
  fallback?: Record<string, Record<string, Json>[]>;
  ids?: Record<string, number>;
  seqs?: Record<string, number>;
  clockOffsetMs: number;
  webhookSecret?: string;
  endpoints?: Endpoint[];
}

class TwinError extends Error {
  constructor(readonly spec: ErrorSpec, readonly vars: Record<string, Json> = {}) { super(spec.message); }
}

const META = "__";
const MAX_BODY = 1024 * 1024;
const LOG_MAX = 500;

interface CompiledOp { op: OperationDef; re: RegExp; params: string[]; key: string }

function compilePath(path: string): { re: RegExp; params: string[] } {
  const params: string[] = [];
  const src = path
    .split("/")
    .map((seg) => {
      // a segment may mix literals and params: `{AccountSid}.json`, `Messages.json`
      return seg.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{([^}]+?)\\?\}/g, (_m, name: string) => {
        params.push(name.replace(/\\/g, ""));
        return "([^/]+?)";
      });
    })
    .join("/");
  return { re: new RegExp(`^${src}/?$`), params };
}

export class Twin {
  readonly def: TwinDefinition;
  readonly store = new Map<string, Map<string, Record<string, Json>>>();
  readonly requests: LoggedRequest[] = [];
  readonly deliveries: LoggedDelivery[] = [];
  readonly warnings: string[] = [];
  readonly webhookSecret: string;
  private ops: CompiledOp[] = [];
  private collectionRoutes: { re: RegExp; params: string[]; resource: string; path: string }[] = [];
  private ids = new IdFactory();
  private seqs = new Map<string, number>();
  private forced = new Map<string, string[]>();
  private idem = new Map<string, TwinResponse>();
  private rate: number[] = [];
  private clockOffsetMs = 0;
  private timers = new Set<NodeJS.Timeout>();
  private endpoints: Endpoint[] = [];
  private rng: () => number;
  private listeners = new Set<(kind: "request" | "delivery" | "state", data: unknown) => void>();
  chaos: ChaosConfig | null;

  constructor(def: TwinDefinition, readonly opts: TwinOptions) {
    this.def = def;
    this.chaos = opts.chaos ?? null;
    this.rng = mulberry32(this.chaos?.seed ?? 1);
    const sp = def.webhooks?.signing.secretPrefix ?? (def.webhooks?.signing.scheme === "svix" ? "whsec_" : "whsec_");
    this.webhookSecret = opts.webhookSecret ?? (def.webhooks?.signing.scheme === "svix"
      ? `whsec_${Buffer.from(randomAlnum(24)).toString("base64")}`
      : `${sp}${randomAlnum(32)}`);
    for (const r of Object.keys(def.resources)) this.store.set(r, new Map());
    for (const op of def.operations) {
      const full = `${def.basePath ?? ""}${op.path}`.replace(/\/+/g, "/");
      const { re, params } = compilePath(full);
      this.ops.push({ op, re, params, key: `${op.method.toUpperCase()} ${op.path}` });
    }
    // collection routes implied by item routes (used by the REST fallback)
    const seen = new Set<string>();
    for (const op of def.operations) {
      if (!op.resource || !["read", "update", "delete"].includes(op.action)) continue;
      const coll = op.path.replace(/\/\{[^}]+\}(\.json)?$/, (_m, ext: string | undefined) => (ext ?? ""));
      if (coll === op.path || seen.has(coll)) continue;
      seen.add(coll);
      const { re, params } = compilePath(`${def.basePath ?? ""}${coll}`.replace(/\/+/g, "/"));
      this.collectionRoutes.push({ re, params, resource: op.resource, path: coll });
    }
    // literal segments before params: `/customers/search` must win over `/customers/{id}`
    this.ops.sort((a, b) => specificity(b.op.path) - specificity(a.op.path));
    for (const url of opts.webhookUrls ?? []) this.addEndpoint(url, ["*"], this.webhookSecret);
  }

  // ---------- public control surface ----------

  onChange(fn: (kind: "request" | "delivery" | "state", data: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(kind: "request" | "delivery" | "state", data: unknown): void {
    for (const l of this.listeners) { try { l(kind, data); } catch { /* listener errors never break the twin */ } }
  }

  addEndpoint(url: string, events: string[] = ["*"], secret = this.webhookSecret): Endpoint {
    if (!isLoopbackUrl(url, this.opts.allowWebhookHosts)) {
      throw new Error(`Webhook URL not allowed: ${url}. Mock Anything delivers webhooks to localhost only (add hosts with --allow-webhook-host).`);
    }
    const ep = { id: `we_${randomAlnum(14)}`, url, events, secret };
    this.endpoints.push(ep);
    return ep;
  }
  listEndpoints(): { id: string; url: string; events: string[] }[] {
    return this.endpoints.map(({ id, url, events }) => ({ id, url, events }));
  }

  scenarioNames(): { name: string; on: string; description: string; trigger: string }[] {
    return Object.entries(this.def.scenarios ?? {}).map(([name, s]) => ({
      name, on: s.on, description: s.description, trigger: s.when ? "magic value or forced" : "forced only",
    }));
  }
  /** Make the next `times` matching operations use this scenario. */
  forceScenario(name: string, times = 1): void {
    const s = this.def.scenarios?.[name];
    if (!s) throw new Error(`Unknown scenario "${name}". Known: ${Object.keys(this.def.scenarios ?? {}).join(", ") || "none"}`);
    const q = this.forced.get(s.on) ?? [];
    for (let i = 0; i < times; i++) q.push(name);
    this.forced.set(s.on, q);
  }

  advanceClock(ms: number): number { this.clockOffsetMs += ms; return this.nowMs(); }
  nowMs(): number { return Date.now() + this.clockOffsetMs; }

  setChaos(c: ChaosConfig | null): void { this.chaos = c; if (c) this.rng = mulberry32(c.seed); }

  snapshot(): Record<string, Json[]> {
    const out: Record<string, Json[]> = {};
    for (const [r, m] of this.store) out[r] = [...m.values()].map((o) => this.output(r, o, []));
    for (const [p, m] of this.fallback) out[`(not in spec) ${p}`] = [...m.values()].map(plain);
    return out;
  }

  reset(): void {
    for (const m of this.store.values()) m.clear();
    this.fallback.clear();
    this.sampled.clear();
    this.ids.reset();
    this.seqs.clear();
    this.forced.clear();
    this.idem.clear();
    this.requests.length = 0;
    this.deliveries.length = 0;
    this.clockOffsetMs = 0;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.notify("state", null);
  }

  close(): void { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  /** Everything needed to pick up where the twin left off: objects, id counters, clock, webhook endpoints. */
  exportState(): SavedState {
    const store: Record<string, Record<string, Json>[]> = {};
    for (const [r, m] of this.store) store[r] = [...m.values()];
    const fallback: Record<string, Record<string, Json>[]> = {};
    for (const [p, m] of this.fallback) fallback[p] = [...m.values()];
    return {
      mockanything: 1, twin: this.def.id, savedAt: new Date().toISOString(),
      store, fallback, ids: this.ids.dump(), seqs: Object.fromEntries(this.seqs), clockOffsetMs: this.clockOffsetMs,
      webhookSecret: this.webhookSecret, endpoints: this.endpoints.map((e) => ({ ...e })),
    };
  }

  /** Restore a saved state. Objects for resources this twin no longer has are dropped (and counted). */
  importState(s: SavedState): { objects: number; dropped: number } {
    if (!s || s.mockanything !== 1) throw new Error("Not a Mock Anything state file");
    if (s.twin !== this.def.id) throw new Error(`This state was saved by the "${s.twin}" twin, not "${this.def.id}". Use a different --state file.`);
    let objects = 0, dropped = 0;
    for (const m of this.store.values()) m.clear();
    for (const [r, list] of Object.entries(s.store ?? {})) {
      const m = this.store.get(r);
      if (!m || !Array.isArray(list)) { dropped += Array.isArray(list) ? list.length : 0; continue; }
      const idf = this.idField(r);
      for (const o of list) {
        if (!o || typeof o !== "object" || o[idf] === undefined || o[idf] === null) { dropped++; continue; }
        m.set(String(o[idf]), o); objects++;
      }
    }
    this.fallback.clear();
    for (const [p, list] of Object.entries(s.fallback ?? {})) {
      if (!Array.isArray(list)) continue;
      const m = new Map<string, Record<string, Json>>();
      for (const o of list) if (o && typeof o === "object" && o.id !== undefined) { m.set(String(o.id), o); objects++; }
      this.fallback.set(p, m);
    }
    this.ids.load(s.ids ?? {});
    this.seqs = new Map(Object.entries(s.seqs ?? {}).filter(([, v]) => Number.isFinite(v)));
    this.clockOffsetMs = Number.isFinite(s.clockOffsetMs) ? s.clockOffsetMs : 0;
    for (const e of s.endpoints ?? []) {
      if (this.endpoints.some((x) => x.url === e.url)) continue;
      if (e && typeof e.url === "string" && isLoopbackUrl(e.url, this.opts.allowWebhookHosts)) {
        this.endpoints.push({ id: String(e.id), url: e.url, events: Array.isArray(e.events) ? e.events.map(String) : ["*"], secret: String(e.secret ?? this.webhookSecret) });
      }
    }
    this.notify("state", null);
    return { objects, dropped };
  }

  /** Emit an arbitrary event (MCP/dashboard "send test webhook"). */
  async emitManual(type: string, resource?: string, id?: string): Promise<void> {
    const obj = resource && id ? this.store.get(resource)?.get(id) : undefined;
    this.emit(type, resource ?? "", obj ?? {}, this.baseCtx({}, {}, {}, {}, ""));
  }

  // ---------- request handling ----------

  async handle(req: TwinRequest): Promise<TwinResponse> {
    const started = Date.now();
    const method = req.method.toUpperCase();
    const headers = lower(req.headers);
    const log: LoggedRequest = { id: randomAlnum(12), at: this.nowMs(), method, path: req.path, status: 0, durationMs: 0, requestHeaders: maskHeaders(headers) };
    let res: TwinResponse;
    try {
      res = await this.dispatch(method, req, headers, log);
    } catch (e) {
      if (e instanceof TwinError) res = this.errorResponse(e.spec, e.vars);
      else res = this.errorResponse(this.errSpec("serverError", { status: 500, message: "Mock Anything internal error" }), {});
      if (!(e instanceof TwinError)) log.warning = `internal: ${(e as Error).message}`;
    }
    log.status = res.status;
    log.durationMs = Date.now() - started + (res.delayMs ?? 0);
    try { log.responseBody = res.body ? maskCards(safeJsonParse(res.body)) : undefined; } catch { log.responseBody = res.body ?? null; }
    this.requests.push(log);
    if (this.requests.length > LOG_MAX) this.requests.shift();
    this.notify("request", log);
    return res;
  }

  private async dispatch(method: string, req: TwinRequest, headers: Record<string, string>, log: LoggedRequest): Promise<TwinResponse> {
    // rate limit profile
    if (this.def.rateLimit) {
      const now = Date.now();
      this.rate = this.rate.filter((t) => now - t < this.def.rateLimit!.windowMs);
      if (this.rate.length >= this.def.rateLimit.limit) {
        return this.withHeaders(this.errorResponse(this.errSpec("rateLimited", { status: 429, message: "Too many requests" }), {}), { "retry-after": "1" });
      }
      this.rate.push(now);
    }

    const match = this.match(method, req.path);
    if (!match && this.def.fallback === "rest" && (method === "POST" || method === "GET")) {
      // the spec knows items at `/things/{id}` but not the collection route: create/list into that resource
      const coll = this.collectionRoutes.find((x) => x.re.test(req.path));
      if (coll) {
        const params: Record<string, string> = {};
        const m = req.path.match(coll.re)!;
        coll.params.forEach((p, i) => { params[p] = decodeURIComponent(m[i + 1] ?? ""); });
        const key = this.authenticate(headers, req.rawQuery ?? "", log);
        const body = this.applyBodyMap(this.parseBody(req.rawBody ?? "", headers["content-type"] ?? ""));
        if (findRealCard(body, this.def.testCards ?? [])) throw new TwinError(this.errSpec("realCard", { status: 400, message: "This looks like a real card number. Mock Anything only accepts documented test card numbers.", code: "real_card_refused" }));
        log.operation = `${method} ${coll.path} (not in spec, inferred from ${coll.resource})`;
        log.requestBody = maskCards(body);
        const ctx = this.baseCtx(body, params, parseForm(req.rawQuery ?? ""), headers, key);
        ctx.$path = req.path;
        const op: OperationDef = { method, path: coll.path, action: method === "POST" ? "create" : "list", resource: coll.resource };
        return this.withHeaders(await this.runOperation(op, ctx, log), { "x-mockanything-fallback": "inferred" });
      }
    }
    if (!match && this.def.fallback === "rest") {
      this.authenticate(headers, req.rawQuery ?? "", log);
      const body = this.parseBody(req.rawBody ?? "", headers["content-type"] ?? "");
      if (findRealCard(body, this.def.testCards ?? [])) throw new TwinError(this.errSpec("realCard", { status: 400, message: "This looks like a real card number. Mock Anything only accepts documented test card numbers.", code: "real_card_refused" }));
      log.operation = "fallback (not in spec)";
      log.requestBody = maskCards(body);
      return this.withHeaders(this.fallbackRest(method, req.path, body), { "x-mockanything-fallback": "rest" });
    }
    if (!match) {
      throw new TwinError(this.errSpec("notFound", { status: 404, message: "Unrecognized request URL" }), {
        $message: `Unrecognized request URL (${method}: ${req.path}). This ${this.def.title} twin supports: ${this.supportedSummary()}`,
      });
    }
    const { c, params } = match;
    log.operation = c.key;

    // chaos before any state change
    let delayMs = 0;
    if (this.chaos && this.rng() < this.chaos.rate) {
      const reqModes = this.chaos.modes.filter((m) => m === "timeout" || m === "5xx" || m === "slow" || m === "429");
      const mode = reqModes[Math.floor(this.rng() * reqModes.length)];
      if (mode) {
        log.chaos = mode;
        if (mode === "slow") delayMs = 1000 + Math.floor(this.rng() * 3000);
        if (mode === "timeout") return { ...this.errorResponse(this.errSpec("serverError", { status: 504, message: "Gateway timeout" }), { $status: 504 }), delayMs: this.opts.timeoutMs ?? 30_000 };
        if (mode === "5xx") {
          const status = [500, 502, 503][Math.floor(this.rng() * 3)]!;
          return this.errorResponse(this.errSpec("serverError", { status, message: "An error occurred with our connection to the provider. Try again." }), { $status: status });
        }
        if (mode === "429") return this.withHeaders(this.errorResponse(this.errSpec("rateLimited", { status: 429, message: "Too many requests" }), {}), { "retry-after": "1" });
      }
    }

    // auth
    const key = this.authenticate(headers, req.rawQuery ?? "", log);

    // body
    if ((req.rawBody?.length ?? 0) > MAX_BODY) throw new TwinError({ status: 413, message: "Request body too large" });
    const query = parseForm(req.rawQuery ?? "");
    let body = this.parseBody(req.rawBody ?? "", headers["content-type"] ?? "");
    body = this.applyBodyMap(body);

    const realCard = findRealCard(body, this.def.testCards ?? []);
    if (realCard) {
      throw new TwinError(this.errSpec("realCard", { status: 400, message: "This looks like a real card number. Mock Anything only accepts documented test card numbers; never send real card details to a test server.", code: "real_card_refused" }));
    }
    log.requestBody = maskCards(body);

    // idempotency
    const idemHeader = this.def.conventions?.idempotencyHeader?.toLowerCase();
    const idemKey = idemHeader && method === "POST" ? headers[idemHeader] : undefined;
    if (idemKey) {
      const cached = this.idem.get(`${c.key}|${idemKey}`);
      if (cached) return this.withHeaders(cached, { "idempotent-replayed": "true" });
    }

    const ctx = this.baseCtx(body, params, query, headers, key);
    ctx.$path = req.path;
    for (const r of c.op.require ?? []) if (!evalCondition(r.when, ctx)) throw new TwinError(r.error);

    let res = await this.runOperation(c.op, ctx, log);
    if (delayMs) res = { ...res, delayMs: (res.delayMs ?? 0) + delayMs };
    if (idemKey && res.status < 500) this.idem.set(`${c.key}|${idemKey}`, res);
    return res;
  }

  private fallback = new Map<string, Map<string, Record<string, Json>>>();
  /** Resource+scope pairs that already got sample objects for lists. */
  private sampled = new Set<string>();

  /** A made-up object for a read-only resource, built from its defaults (the spec's examples and shapes). */
  private sampleObject(resource: string, ctx: EvalContext, id?: string): Record<string, Json> {
    const r = this.res(resource);
    const scope = this.scopeOf(resource, ctx);
    const idField = this.idField(resource);
    const obj: Record<string, Json> = Object.create(null);
    const asId: Json = id === undefined ? this.ids.next(r.id, JSON.stringify(scope)) as Json : (r.id?.style === "int" || r.id?.style === "sequence") && /^\d+$/.test(id) ? Number(id) : id;
    obj[idField] = asId;
    obj.__nonce = randomAlnum(20);
    obj.__scope = scope;
    const sctx = { ...ctx, obj, body: {} } as EvalContext;
    for (const [k, t] of Object.entries(r.defaults ?? {})) obj[k] = render(t, sctx);
    obj[idField] = asId;
    if (r.lifecycle && (obj[r.lifecycle.field] === undefined || obj[r.lifecycle.field] === null)) obj[r.lifecycle.field] = render(r.lifecycle.initial, sctx);
    this.store.get(resource)!.set(String(asId), obj);
    this.notify("state", null);
    return obj;
  }
  /** Generic REST for paths a spec doesn't describe: POST creates, GET reads/lists, PUT/PATCH merges, DELETE removes. */
  private fallbackRest(method: string, path: string, body: Record<string, Json>): TwinResponse {
    const rel = path.slice((this.def.basePath ?? "").length) || "/";
    const segs = rel.split("/").filter(Boolean);
    const idLike = (s: string) => /^\d+$/.test(s) || /^[0-9a-f-]{32,36}$/i.test(s) || /^[A-Za-z]{1,8}_[A-Za-z0-9]{6,}$/.test(s);
    const last = segs.at(-1);
    let collection = "/" + segs.join("/");
    let id: string | undefined;
    if (last && segs.length > 1) {
      const parent = "/" + segs.slice(0, -1).join("/");
      if (this.fallback.get(parent)?.has(last) || (method !== "POST" && idLike(last))) { collection = parent; id = last; }
    }
    const store = this.fallback.get(collection) ?? new Map<string, Record<string, Json>>();
    this.fallback.set(collection, store);
    const now = new Date(this.nowMs()).toISOString();
    if (!id) {
      if (method === "POST" || method === "PUT") {
        const newId = String(body.id ?? randomUUID());
        const obj = { ...body, id: newId, created_at: body.created_at ?? now } as Record<string, Json>;
        store.set(newId, obj);
        this.notify("state", null);
        return this.json(201, plain(obj));
      }
      if (method === "GET" || method === "HEAD") return this.json(200, [...store.values()].reverse().map(plain));
      return this.json(405, { error: { message: `Method ${method} not supported on ${path}` } });
    }
    const obj = store.get(id);
    if (!obj) return this.json(404, { error: { message: `No such object: '${id}'`, code: "resource_missing" } });
    if (method === "GET" || method === "HEAD") return this.json(200, plain(obj));
    if (method === "PATCH" || method === "PUT" || method === "POST") {
      Object.assign(obj, body, { id, updated_at: now });
      this.notify("state", null);
      return this.json(200, plain(obj));
    }
    if (method === "DELETE") { store.delete(id); this.notify("state", null); return this.json(200, { id, deleted: true }); }
    return this.json(405, { error: { message: `Method ${method} not supported` } });
  }

  private supportedSummary(): string {
    return this.def.operations.slice(0, 12).map((o) => `${o.method.toUpperCase()} ${this.def.basePath ?? ""}${o.path}`).join(", ") + (this.def.operations.length > 12 ? ", …" : "");
  }

  private match(method: string, path: string): { c: CompiledOp; params: Record<string, string> } | null {
    for (const c of this.ops) {
      if (c.op.method.toUpperCase() !== method && !(method === "HEAD" && c.op.method.toUpperCase() === "GET")) continue;
      const m = path.match(c.re);
      if (!m) continue;
      const params: Record<string, string> = {};
      c.params.forEach((p, i) => { params[p] = decodeURIComponent(m[i + 1] ?? ""); });
      return { c, params };
    }
    return null;
  }

  private authenticate(headers: Record<string, string>, rawQuery: string, log: LoggedRequest): string {
    const a = this.def.auth;
    let key = "";
    if (a.type === "bearer") {
      const h = headers["authorization"] ?? "";
      const m = h.match(/^(?:Bearer|token)\s+(.+)$/i);
      if (m) key = m[1]!.trim();
      else if (/^Basic\s+/i.test(h)) key = basicKey(h);
    } else if (a.type === "basic") {
      const h = headers["authorization"] ?? "";
      key = /^Basic\s+/i.test(h) ? basicKey(h) : (h.match(/^(?:Bearer|token)\s+(.+)$/i)?.[1]?.trim() ?? "");
    } else if (a.type === "header") {
      key = headers[(a.name ?? "x-api-key").toLowerCase()] ?? "";
      // newer SDKs (Anthropic's among them) send the same key as a bearer token
      if (!key) key = (headers["authorization"] ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    } else if (a.type === "query") {
      key = new URLSearchParams(rawQuery).get(a.name ?? "api_key") ?? "";
    }
    if (a.type !== "none" && !key && !a.optional) {
      throw new TwinError(this.errSpec("unauthorized", { status: 401, message: "No API key provided. Any test key works with Mock Anything (for example the one printed when the twin started)." }));
    }
    if (key && a.livePattern && safeMatch(a.livePattern, key)) {
      log.warning = "live key refused";
      throw new TwinError(this.errSpec("liveKey", { status: 401, message: "This looks like a live (production) key. Mock Anything refuses live keys: use a test key, or any placeholder value." }));
    }
    if (key && a.warnPattern && safeMatch(a.warnPattern, key)) {
      const w = "This looks like a real access token. The twin never needs one: use any placeholder value.";
      log.warning = w;
      if (!this.warnings.includes(w)) this.warnings.push(w);
    }
    return key;
  }

  private parseBody(raw: string, contentType: string): Record<string, Json> {
    if (!raw) return {};
    try {
      if (contentType.includes("json")) {
        const v = safeJsonParse(raw);
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : { _: v };
      }
      if (contentType.includes("x-www-form-urlencoded")) return parseForm(raw);
      const t = raw.trimStart();
      if (t.startsWith("{")) return safeJsonParse(raw) as Record<string, Json>;
      return parseForm(raw);
    } catch {
      throw new TwinError({ status: 400, message: "Invalid request body" });
    }
  }

  private applyBodyMap(body: Record<string, Json>): Record<string, Json> {
    const map = this.def.conventions?.bodyMap;
    if (!map) return body;
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(body)) out[map[k] ?? k] = v;
    return out;
  }

  private baseCtx(body: Record<string, Json>, params: Record<string, string>, query: Record<string, Json>, headers: Record<string, string>, key: string): EvalContext {
    const nowMs = this.nowMs();
    const ts = this.def.conventions?.timestamps ?? "unix";
    const rfc = new Date(nowMs).toUTCString().replace("GMT", "+0000");
    const ctx: EvalContext = {
      body, params, query, headers,
      now: ts === "iso" ? new Date(nowMs).toISOString() : ts === "rfc2822" ? rfc : Math.floor(nowMs / 1000),
      nowRfc2822: rfc,
      nowUnix: Math.floor(nowMs / 1000),
      nowMs,
      nowIso: new Date(nowMs).toISOString(),
      twin: { baseUrl: this.opts.baseUrl, id: this.def.id, title: this.def.title },
      $key: key,
    };
    ctx.fns = {
      newId: (prefix, len) => `${String(prefix ?? "")}${randomAlnum(typeof len === "number" ? len : 24)}`,
      hex: (n, prefix) => `${String(prefix ?? "")}${randomHex(typeof n === "number" ? n : 32)}`,
      uuid: () => randomUUID(),
      digits: (n) => String(Math.floor(Math.random() * 10 ** Math.min(Number(n) || 6, 15))).padStart(Math.min(Number(n) || 6, 15), "0"),
      checkoutUrl: () => {
        const o = ctx.obj as Record<string, Json> | undefined;
        const r = ctx.$resource as string | undefined;
        if (!o || !r) return null;
        return `${this.opts.baseUrl}/__mockanything/checkout/${encodeURIComponent(r)}/${encodeURIComponent(String(o[this.idField(r)]))}?nonce=${String(o.__nonce ?? "")}`;
      },
      seq: (scopeName) => {
        const scopeKey = `${scopeName ? `named:${String(scopeName)}` : String(ctx.$resource ?? "")}:${JSON.stringify(ctx.$scope ?? {})}`;
        const n = (this.seqs.get(scopeKey) ?? 0) + 1;
        this.seqs.set(scopeKey, n);
        return n;
      },
      secret: () => this.webhookSecret,
      upper: (s) => String(s ?? "").toUpperCase(),
      lower: (s) => String(s ?? "").toLowerCase(),
      json: (v) => JSON.stringify(v),
      int: (x) => Math.trunc(Number(x) || 0),
      add: (a, b) => (Number(a) || 0) + (Number(b) || 0),
      sub: (a, b) => (Number(a) || 0) - (Number(b) || 0),
      mul: (a, b) => (Number(a) || 0) * (Number(b) || 0),
      concat: (...xs) => xs.map((x) => (x === null || x === undefined ? "" : String(x))).join(""),
    };
    return ctx;
  }

  private idField(resource: string): string {
    return this.def.resources[resource]?.id && "field" in (this.def.resources[resource]!.id!) && this.def.resources[resource]!.id!.field
      ? this.def.resources[resource]!.id!.field!
      : this.def.conventions?.idField ?? "id";
  }

  private res(resource: string): ResourceDef {
    const r = this.def.resources[resource];
    if (!r) throw new TwinError({ status: 500, message: `Twin definition error: unknown resource "${resource}"` });
    return r;
  }

  private async runOperation(op: OperationDef, ctx: EvalContext, log: LoggedRequest): Promise<TwinResponse> {
    const resource = op.resource ?? "";
    ctx.$resource = resource;
    switch (op.action) {
      case "create": {
        const res = this.opCreate(op, resource, ctx, log);
        if (op.stream && res.status < 300 && evalCondition(op.stream.when, ctx)) return this.streamResponse(op.stream, resource, ctx);
        return res;
      }
      case "read": {
        const obj = this.find(op, resource, ctx);
        ctx.obj = obj;
        return this.respondObject(op, resource, obj, ctx, 200);
      }
      case "update": return this.opUpdate(op, resource, ctx);
      case "delete": {
        const obj = this.find(op, resource, ctx);
        ctx.obj = obj;
        this.store.get(resource)!.delete(String(obj[this.idField(resource)]));
        this.runEmits(op.emit ?? [], resource, obj, ctx);
        this.notify("state", null);
        const status = op.response?.status ?? this.def.conventions?.deleteStatus ?? 200;
        if (status === 204) return { status: 204, headers: {} };
        const out = this.output(resource, obj, []);
        const body = op.response?.body ?? this.def.conventions?.deleteBody ?? "{{$data}}";
        return this.json(status, render(body, { ...ctx, $data: out, obj: out }));
      }
      case "list": return this.opList(op, resource, ctx);
      case "transition": {
        const obj = this.find(op, resource, ctx);
        ctx.obj = obj;
        this.mergeBody(resource, obj, ctx.body as Record<string, Json>, false);
        const r = this.runTransition(resource, obj, op.transition ?? "", ctx, log);
        this.runEmits(op.emit ?? [], resource, obj, ctx);
        this.notify("state", null);
        if (r.error) throw new TwinError(r.error, r.vars);
        const res = this.respondObject(op, resource, obj, ctx, 200);
        return r.delayMs ? { ...res, delayMs: r.delayMs } : res;
      }
      case "static": {
        const body = render(op.response?.body ?? {}, ctx);
        return this.json(op.response?.status ?? 200, body);
      }
    }
  }

  private scopeOf(resource: string, ctx: EvalContext): Record<string, string> {
    const r = this.def.resources[resource];
    const params = ctx.params as Record<string, string>;
    const s: Record<string, string> = {};
    for (const p of r?.scope ?? []) if (params[p] !== undefined) s[p] = params[p]!;
    return s;
  }

  private find(op: OperationDef, resource: string, ctx: EvalContext): Record<string, Json> {
    const m = this.store.get(resource);
    if (!m) throw new TwinError({ status: 500, message: `Twin definition error: unknown resource "${resource}"` });
    const scope = this.scopeOf(resource, ctx);
    const inScope = (o: Record<string, Json>) => Object.entries(scope).every(([k, v]) => (o.__scope as Record<string, Json> | undefined)?.[k] === v);
    const params = ctx.params as Record<string, string>;
    let wanted: string;
    let found: Record<string, Json> | undefined;
    if (op.lookup) {
      wanted = String(renderString(op.lookup.from, ctx) ?? "");
      for (const o of m.values()) {
        if (inScope(o) && op.lookup.fields.some((f) => { const v = lookupField(o, f); return v !== undefined && v !== null && String(v) === wanted; })) { found = o; break; }
      }
    } else {
      const idParam = op.idParam ?? Object.keys(params).at(-1) ?? "id";
      wanted = params[idParam] ?? "";
      found = m.get(wanted);
      if (found && !inScope(found)) found = undefined;
    }
    if (!found && !op.lookup && this.def.resources[resource]?.sample && wanted) found = this.sampleObject(resource, ctx, wanted);
    if (!found) {
      const singular = this.def.resources[resource]?.singular ?? singularize(resource);
      throw new TwinError(this.errSpec("notFound", { status: 404, message: "No such {{$resource}}: '{{$id}}'", code: "resource_missing", param: "id" }), {
        $resource: singular, $id: wanted,
      });
    }
    return found;
  }

  private mergeBody(resource: string, obj: Record<string, Json>, body: Record<string, Json>, isCreate: boolean): void {
    const r = this.res(resource);
    const ignore = new Set(this.def.conventions?.ignore ?? []);
    const readonly = new Set(r.readonly ?? []);
    const idField = this.idField(resource);
    const accept = r.accept ?? "*";
    for (const [k, v] of Object.entries(body)) {
      if (k.startsWith(META) || ignore.has(k) || readonly.has(k) || k === idField) continue;
      if (accept !== "*" && !accept.includes(k)) continue;
      if (!isCreate && r.lifecycle?.field === k) continue; // state changes go through transitions
      const typed = coerce(v, r.types?.[k]);
      const prev = obj[k];
      if (typed && typeof typed === "object" && !Array.isArray(typed) && prev && typeof prev === "object" && !Array.isArray(prev)) {
        const merged: Record<string, Json> = { ...(prev as Record<string, Json>) };
        for (const [mk, mv] of Object.entries(typed)) { if (mv === "") delete merged[mk]; else merged[mk] = mv; }
        obj[k] = merged;
      } else {
        obj[k] = typed;
      }
    }
  }

  private checkRefs(resource: string, obj: Record<string, Json>, body: Record<string, Json>): void {
    const r = this.res(resource);
    for (const [field, target] of Object.entries(r.refs ?? {})) {
      const v = body[field];
      if (typeof v !== "string" || !v) continue;
      const m = this.store.get(target);
      if (!m || m.has(v)) continue;
      // nothing in the API can create the target (models, regions, plans…): any value is accepted, like the real API's catalogue
      if (this.def.resources[target]?.sample || !this.def.operations.some((o) => o.resource === target && o.action === "create")) continue;
      const singular = this.def.resources[target]?.singular ?? singularize(target);
      throw new TwinError({ ...this.errSpec("notFound", { status: 404, message: "No such {{$resource}}: '{{$id}}'", code: "resource_missing" }), status: 400, param: field }, { $resource: singular, $id: v, $param: field });
    }
    void obj;
  }

  private opCreate(op: OperationDef, resource: string, ctx: EvalContext, log: LoggedRequest): TwinResponse {
    const r = this.res(resource);
    const body = ctx.body as Record<string, Json>;
    for (const f of r.required ?? []) {
      if (body[f] === undefined || body[f] === null || body[f] === "") {
        throw new TwinError(this.errSpec("missingParam", { status: 400, message: "Missing required param: {{$param}}.", code: "parameter_missing", param: "{{$param}}" }), { $param: f, $resource: r.singular ? r.singular.charAt(0).toUpperCase() + r.singular.slice(1) : singularize(resource) });
      }
    }
    this.checkRefs(resource, {}, body);
    const scope = this.scopeOf(resource, ctx);
    ctx.$scope = scope;
    const idField = this.idField(resource);
    // effects on other objects: validated before anything is stored; the first target is `target` in templates
    const effectTargets = this.prepareEffects(op, ctx);
    if (effectTargets[0]) ctx.target = effectTargets[0].target;
    const obj: Record<string, Json> = Object.create(null);
    obj[idField] = this.ids.next(r.id, JSON.stringify(scope)) as Json;
    obj.__nonce = randomAlnum(20);
    obj.__scope = scope;
    obj.__key = ctx.$key as string;
    ctx.obj = obj;
    for (const [k, t] of Object.entries(r.defaults ?? {})) obj[k] = render(t, ctx);
    this.mergeBody(resource, obj, body, true);
    for (const [k, t] of Object.entries(op.set ?? {})) obj[k] = render(t, ctx);
    if (r.lifecycle && (obj[r.lifecycle.field] === undefined || obj[r.lifecycle.field] === null)) {
      const w = r.lifecycle.initialWhen?.find((x) => evalCondition(x.when, ctx));
      obj[r.lifecycle.field] = render(w ? w.value : r.lifecycle.initial, ctx);
    }

    for (const u of r.unique ?? []) {
      const v = lookupField(obj, u.field);
      if (v === undefined || v === null || v === "") continue;
      for (const o of this.store.get(resource)!.values()) {
        if (String(lookupField(o, u.field)) === String(v)) throw new TwinError(u.error, { $value: v, $param: u.field });
      }
    }

    // scenarios on create
    const sc = this.pickScenario(`${resource}.create`, ctx);
    if (sc) {
      log.scenario = sc.name;
      if (sc.s.error && !sc.s.to && !sc.s.set) throw new TwinError(sc.s.error);
      this.applyChange(obj, resource, sc.s, ctx);
    }

    this.store.get(resource)!.set(String(obj[idField]), obj);

    // webhook endpoint registration (Stripe webhook_endpoints)
    const reg = this.def.webhooks?.registration;
    if (reg && reg.resource === resource) {
      const url = String(obj[reg.urlField] ?? "");
      try {
        const events = reg.eventsField ? (Array.isArray(obj[reg.eventsField]) ? (obj[reg.eventsField] as Json[]).map(String) : ["*"]) : ["*"];
        const secret = `whsec_${randomAlnum(32)}`;
        this.addEndpoint(url, events, secret);
        if (reg.secretField) obj[reg.secretField] = secret;
      } catch (e) {
        this.store.get(resource)!.delete(String(obj[idField]));
        throw new TwinError({ status: 400, message: (e as Error).message, code: "url_invalid", param: reg.urlField });
      }
    }

    this.runEmits(op.emit ?? [], resource, obj, ctx);
    this.applyEffects(effectTargets, ctx);
    if (sc?.s.emit) this.runEmits(sc.s.emit, resource, obj, ctx);

    let thenErr: { error: ErrorSpec; vars: Record<string, Json> } | null = null;
    for (const t of op.then ?? []) {
      if (!evalCondition(t.when, ctx)) continue;
      const tr = this.runTransition(resource, obj, t.transition, ctx, log);
      if (tr.error) { thenErr = { error: tr.error, vars: tr.vars }; break; }
    }
    this.scheduleAuto(resource, obj);
    this.notify("state", null);
    if (sc?.s.error) throw new TwinError(sc.s.error);
    if (thenErr) throw new TwinError(thenErr.error, thenErr.vars);
    const status = op.response?.status ?? this.def.conventions?.createStatus ?? 200;
    return this.respondObject(op, resource, obj, ctx, status, sc?.s.delayMs);
  }

  private opUpdate(op: OperationDef, resource: string, ctx: EvalContext): TwinResponse {
    const r = this.res(resource);
    const obj = this.find(op, resource, ctx);
    ctx.obj = obj;
    const body = ctx.body as Record<string, Json>;
    this.checkRefs(resource, obj, body);
    this.mergeBody(resource, obj, body, false);
    for (const [k, t] of Object.entries(op.set ?? {})) obj[k] = render(t, ctx);
    for (const [k, t] of Object.entries(r.onUpdate ?? {})) obj[k] = render(t, ctx);
    let err: { error: ErrorSpec; vars: Record<string, Json> } | null = null;
    for (const t of op.then ?? []) {
      if (!evalCondition(t.when, ctx)) continue;
      const tr = this.runTransition(resource, obj, t.transition, ctx, { } as LoggedRequest);
      if (tr.error) { err = { error: tr.error, vars: tr.vars }; break; }
    }
    this.runEmits(op.emit ?? [], resource, obj, ctx);
    this.notify("state", null);
    if (err) throw new TwinError(err.error, err.vars);
    return this.respondObject(op, resource, obj, ctx, 200);
  }

  private opList(op: OperationDef, resource: string, ctx: EvalContext): TwinResponse {
    const r = this.res(resource);
    const query = ctx.query as Record<string, Json>;
    const scope = this.scopeOf(resource, ctx);
    if (r.sample) {
      const key = `${resource}|${JSON.stringify(scope)}`;
      if (!this.sampled.has(key)) { this.sampled.add(key); for (let i = 0; i < 3; i++) this.sampleObject(resource, ctx); }
    }
    let items = [...this.store.get(resource)!.values()].filter((o) =>
      Object.entries(scope).every(([k, v]) => (o.__scope as Record<string, Json> | undefined)?.[k] === v));
    for (const [param, f] of Object.entries(r.filters ?? {})) {
      const spec = typeof f === "string" ? { field: f } : f;
      const v = query[param] ?? spec.default;
      if (v === undefined || v === null || v === "" || (spec.all !== undefined && String(v) === spec.all)) continue;
      items = items.filter((o) => String(lookupField(o, spec.field)) === String(v));
    }
    const style = this.def.conventions?.listStyle ?? { kind: "cursor" };
    if ((style.order ?? "desc") === "desc") items.reverse();
    const limitParam = style.limitParam ?? "limit";
    const max = style.maxLimit ?? 100;
    const limit = Math.max(1, Math.min(max, Number(query[limitParam] ?? style.defaultLimit ?? 10) || style.defaultLimit || 10));
    const idField = this.idField(resource);
    let page = 1;
    let pageItems: Record<string, Json>[];
    let hasMore: boolean;
    if (style.kind === "page") {
      const base = style.pageBase ?? 1;
      page = Math.max(base, Number(query[style.pageParam ?? "page"] ?? base) || base);
      const start = (page - base) * limit;
      pageItems = items.slice(start, start + limit);
      hasMore = start + limit < items.length;
    } else {
      const after = query[style.afterParam ?? "starting_after"];
      const before = query[style.beforeParam ?? "ending_before"];
      let start = 0;
      if (after) { const i = items.findIndex((o) => String(o[idField]) === String(after)); start = i >= 0 ? i + 1 : 0; }
      if (before) {
        const i = items.findIndex((o) => String(o[idField]) === String(before));
        const end = i >= 0 ? i : items.length;
        pageItems = items.slice(Math.max(0, end - limit), end);
        hasMore = end - limit > 0;
      } else {
        pageItems = items.slice(start, start + limit);
        hasMore = start + limit < items.length;
      }
    }
    const expand = this.expandList(ctx);
    const out = pageItems.map((o) => this.output(resource, o, expand));
    const vars = {
      $items: out, $data: out, $hasMore: hasMore, $total: items.length, $page: page, $limit: limit,
      $pageCount: Math.max(1, Math.ceil(items.length / limit)), $url: String(ctx.$path ?? `${this.def.basePath ?? ""}${op.path}`),
      $skipped: style.kind === "page" ? (page - (style.pageBase ?? 1)) * limit : 0,
      $nextPath: hasMore && style.kind === "page" ? `${String(ctx.$path ?? "")}?${style.pageParam ?? "page"}=${page + 1}&${limitParam}=${limit}` : null,
      $firstPath: style.kind === "page" ? `${String(ctx.$path ?? "")}?${style.pageParam ?? "page"}=${style.pageBase ?? 1}&${limitParam}=${limit}` : String(ctx.$path ?? ""),
    };
    const tpl = op.response?.body ?? this.def.conventions?.list ?? "{{$items}}";
    const headers: Record<string, string> = {};
    if (style.kind === "page" && style.linkHeader) {
      const links: string[] = [];
      const base = `${this.opts.baseUrl}${ctx.$path ?? ""}`;
      if (hasMore) links.push(`<${base}?${style.pageParam ?? "page"}=${page + 1}&${limitParam}=${limit}>; rel="next"`);
      if (page > (style.pageBase ?? 1)) links.push(`<${base}?${style.pageParam ?? "page"}=${page - 1}&${limitParam}=${limit}>; rel="prev"`);
      if (links.length) headers.link = links.join(", ");
    }
    return this.withHeaders(this.json(op.response?.status ?? 200, render(tpl, { ...ctx, ...vars })), headers);
  }

  private expandList(ctx: EvalContext): string[] {
    const p = this.def.conventions?.expandParam;
    if (!p) return [];
    const raw = (ctx.query as Record<string, Json>)[p] ?? (ctx.body as Record<string, Json>)[p];
    if (!raw) return [];
    return (Array.isArray(raw) ? raw : [raw]).map(String);
  }

  private respondObject(op: OperationDef, resource: string, obj: Record<string, Json>, ctx: EvalContext, status: number, delayMs?: number): TwinResponse {
    const out = this.output(resource, obj, this.expandList(ctx));
    const tpl = op.response?.body ?? this.def.conventions?.single ?? "{{$data}}";
    const headers: Record<string, string> = {};
    for (const [k, t] of Object.entries(op.response?.headers ?? {})) headers[k] = String(render(t, { ...ctx, obj: out }) ?? "");
    const res = this.withHeaders(this.json(status, render(tpl, { ...ctx, $data: out, obj: out })), headers);
    return delayMs ? { ...res, delayMs } : res;
  }

  /** Public shape of an object: hidden fields removed, requested refs expanded one level. */
  output(resource: string, obj: Record<string, Json>, expand: string[]): Json {
    const r = this.def.resources[resource];
    const hidden = new Set(r?.hidden ?? []);
    const o: Record<string, Json> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith(META) || hidden.has(k)) continue;
      o[k] = v;
    }
    for (const field of expand) {
      const target = r?.refs?.[field];
      const v = o[field];
      if (!target || typeof v !== "string") continue;
      const ref = this.store.get(target)?.get(v);
      if (ref) o[field] = this.output(target, ref, []);
    }
    return plain(o);
  }

  // ---------- lifecycles, scenarios, effects ----------

  private pickScenario(on: string, ctx: EvalContext, group?: string): { name: string; s: ScenarioDef } | null {
    for (const key of [on, group].filter(Boolean) as string[]) {
      const q = this.forced.get(key);
      if (q?.length) {
        const name = q.shift()!;
        const s = this.def.scenarios?.[name];
        if (s) return { name, s };
      }
    }
    for (const [name, s] of Object.entries(this.def.scenarios ?? {})) {
      if ((s.on === on || (group && s.on === group)) && s.when && evalCondition(s.when, ctx)) return { name, s };
    }
    return null;
  }

  private applyChange(obj: Record<string, Json>, resource: string, ch: { to?: Template; set?: Record<string, Template>; inc?: Record<string, Template> }, ctx: EvalContext): void {
    const r = this.def.resources[resource];
    ctx.obj = obj;
    if (ch.to !== undefined && r?.lifecycle) obj[r.lifecycle.field] = render(ch.to, ctx);
    for (const [k, t] of Object.entries(ch.set ?? {})) obj[k] = render(t, ctx);
    for (const [k, t] of Object.entries(ch.inc ?? {})) obj[k] = (Number(obj[k]) || 0) + (Number(render(t, ctx)) || 0);
  }

  runTransition(resource: string, obj: Record<string, Json>, name: string, ctx: EvalContext, log: Partial<LoggedRequest>): { error?: ErrorSpec; vars: Record<string, Json>; delayMs?: number } {
    const r = this.res(resource);
    const lc = r.lifecycle;
    const t: TransitionDef | undefined = lc?.transitions[name];
    if (!lc || !t) return { error: { status: 500, message: `Twin definition error: no transition "${name}" on ${resource}` }, vars: {} };
    ctx.obj = obj;
    ctx.$resource = resource;
    const state = String(obj[lc.field] ?? "");
    if (t.from && !t.from.includes(state)) {
      const singular = r.singular ?? singularize(resource);
      return {
        error: this.errSpec("invalidState", { status: 400, message: "You cannot {{$transition}} this {{$resource}} because it has a status of {{$state}}.", code: `${singular}_unexpected_state` }),
        vars: { $transition: name, $resource: singular, $resourceKey: singularize(resource), $state: state },
      };
    }
    for (const req of t.require ?? []) if (!evalCondition(req.when, ctx)) return { error: req.error, vars: {} };
    const sc = this.pickScenario(`${resource}.${name}`, ctx, t.scenarios);
    if (sc) {
      if (log) log.scenario = sc.name;
      this.applyChange(obj, resource, sc.s, ctx);
      this.runEmits(sc.s.emit ?? [], resource, obj, ctx);
      return { error: sc.s.error, vars: {}, delayMs: sc.s.delayMs };
    }
    const c = t.cases?.find((x) => evalCondition(x.when, ctx));
    const change = c ?? t;
    this.applyChange(obj, resource, change, ctx);
    this.runEmits(change.emit ?? [], resource, obj, ctx);
    return { vars: {} };
  }

  private scheduleAuto(resource: string, obj: Record<string, Json>): void {
    const lc = this.def.resources[resource]?.lifecycle;
    if (!lc?.auto?.length) return;
    const scale = this.opts.autoScale ?? 1;
    const id = String(obj[this.idField(resource)]);
    const steps = [...lc.auto];
    const runNext = (): void => {
      const step = steps.shift();
      if (!step) return;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        const current = this.store.get(resource)?.get(id);
        if (!current) return;
        const ctx = this.baseCtx({}, {}, {}, {}, String(current.__key ?? ""));
        ctx.obj = current;
        ctx.$resource = resource;
        if (evalCondition(step.when, ctx)) {
          const lcT = lc.transitions[step.transition];
          const state = String(current[lc.field] ?? "");
          if (lcT && (!lcT.from || lcT.from.includes(state))) {
            this.runTransition(resource, current, step.transition, ctx, {});
            this.notify("state", null);
          }
        }
        runNext();
      }, Math.max(1, step.afterMs * scale));
      timer.unref?.();
      this.timers.add(timer);
    };
    runNext();
  }

  private prepareEffects(op: OperationDef, ctx: EvalContext): { eff: NonNullable<OperationDef["effects"]>[number]; target: Record<string, Json> }[] {
    const out: { eff: NonNullable<OperationDef["effects"]>[number]; target: Record<string, Json> }[] = [];
    for (const eff of op.effects ?? []) {
      const m = this.store.get(eff.resource);
      const key = String(renderString(eff.id, ctx) ?? "");
      let target = m?.get(key);
      if (!target && eff.lookup && m) {
        const scope = this.scopeOf(eff.resource, ctx);
        for (const o of m.values()) {
          const inScope = Object.entries(scope).every(([k, v]) => (o.__scope as Record<string, Json> | undefined)?.[k] === v);
          if (inScope && eff.lookup.some((f) => { const v = lookupField(o, f); return v !== undefined && v !== null && String(v) === key; })) { target = o; break; }
        }
      }
      if (!target) {
        if (eff.mustExist) throw new TwinError(eff.mustExist, { $id: key, $resource: this.def.resources[eff.resource]?.singular ?? singularize(eff.resource) });
        continue;
      }
      for (const req of eff.require ?? []) {
        if (!evalCondition(req.when, { ...ctx, target, fns: ctx.fns })) throw new TwinError(req.error);
      }
      out.push({ eff, target });
    }
    return out;
  }

  private applyEffects(list: ReturnType<Twin["prepareEffects"]>, ctx: EvalContext): void {
    for (const { eff, target } of list) {
      const ectx = { ...ctx, target, fns: ctx.fns };
      for (const [k, t] of Object.entries(eff.set ?? {})) target[k] = render(t, ectx);
      for (const [k, t] of Object.entries(eff.inc ?? {})) target[k] = (Number(target[k]) || 0) + (Number(render(t, ectx)) || 0);
      this.runEmits(eff.emit ?? [], eff.resource, target, ectx);
    }
  }

  // ---------- webhooks ----------

  private runEmits(list: EmitDef[], resource: string, obj: Record<string, Json>, ctx: EvalContext): void {
    for (const e of list) this.emit(e, resource, obj, ctx);
  }

  private emit(e: EmitDef, resource: string, obj: Record<string, Json>, ctx: EvalContext): void {
    const wh = this.def.webhooks;
    const def = typeof e === "string" ? { type: e } : e;
    const out = resource ? this.output(resource, obj, []) : (obj as Json);
    const eventId = String(this.ids.next(wh?.eventId ?? { style: "prefixed", prefix: "evt_", length: 24 }));
    const [eventName, ...rest] = def.type.split(".");
    const ectx: EvalContext = {
      ...ctx, obj: out, $object: out, $type: def.type, $eventId: eventId, $created: ctx.nowUnix, $createdIso: ctx.nowIso,
      $eventName: eventName ?? def.type, $action: rest.join(".") || null,
    };
    const payload = render(def.payload ?? wh?.envelope ?? { id: "{{$eventId}}", type: "{{$type}}", created: "{{$created}}", data: { object: "{{$object}}" } }, ectx);
    if (wh?.storeAs && this.store.has(wh.storeAs) && payload && typeof payload === "object" && !Array.isArray(payload)) {
      this.store.get(wh.storeAs)!.set(eventId, { ...(payload as Record<string, Json>), __scope: {} });
    }
    const headers: Record<string, string> = {};
    for (const [k, t] of Object.entries({ ...wh?.headers, ...def.headers })) headers[k] = String(render(t, ectx) ?? "");
    const format = def.format ?? "json";

    let targets: { url: string; secret: string }[];
    if (def.to) {
      // callback URLs are often hidden fields, so read them from the stored object
      const url = String(renderString(def.to, { ...ectx, obj: plain(obj as Json) }) ?? "");
      if (!url) return;
      if (!isLoopbackUrl(url, this.opts.allowWebhookHosts)) {
        this.logDelivery({ id: eventId, at: this.nowMs(), type: def.type, url, status: null, attempt: 0, error: "Not delivered: callback URL is not localhost (add hosts with --allow-webhook-host)", payload });
        return;
      }
      targets = [{ url, secret: this.webhookSecret }];
    } else {
      targets = this.endpoints.filter((ep) => ep.events.includes("*") || ep.events.includes(def.type)).map((ep) => ({ url: ep.url, secret: ep.secret }));
    }
    const requestKey = String(obj.__key ?? ctx.$key ?? "");
    for (const t of targets) {
      const secret = wh?.signing.secretFrom === "requestKey" ? requestKey : t.secret;
      void this.deliver(def.type, t.url, payload, format, headers, secret, eventId);
    }
  }

  private buildSigned(url: string, payload: Json, format: "json" | "form", headers: Record<string, string>, secret: string, eventId: string): { body: string; headers: Record<string, string> } {
    const s = this.def.webhooks?.signing ?? { scheme: "none" as const };
    let body: string;
    const h: Record<string, string> = { "user-agent": "MockAnything-Webhooks/1.0", ...headers };
    if (format === "form") {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries((payload as Record<string, Json>) ?? {})) if (v !== null && v !== undefined) flat[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
      body = new URLSearchParams(flat).toString();
      h["content-type"] = "application/x-www-form-urlencoded";
      if (s.scheme === "hmac-sha1-base64-url") h[(s.header ?? "x-twilio-signature").toLowerCase()] = signTwilio(secret, url, flat);
    } else {
      body = JSON.stringify(payload);
      h["content-type"] = "application/json";
    }
    const header = (s.header ?? "").toLowerCase();
    if (s.scheme === "stripe") h[header || "stripe-signature"] = signStripe(secret, body, Math.floor(this.nowMs() / 1000));
    if (s.scheme === "hmac-sha256-hex") h[header || "x-signature"] = `${s.prefix ?? ""}${signHmacHex("sha256", secret, body)}`;
    if (s.scheme === "hmac-sha512-hex") h[header || "x-signature"] = `${s.prefix ?? ""}${signHmacHex("sha512", secret, body)}`;
    if (s.scheme === "svix") {
      const ts = Math.floor(this.nowMs() / 1000);
      const id = `msg_${eventId}`;
      h["svix-id"] = id;
      h["svix-timestamp"] = String(ts);
      h["svix-signature"] = signSvix(secret, id, ts, body);
    }
    return { body, headers: h };
  }

  private async deliver(type: string, url: string, payload: Json, format: "json" | "form", headers: Record<string, string>, secret: string, eventId: string): Promise<void> {
    const f = this.opts.fetchImpl ?? fetch;
    const dup = !!this.chaos?.modes.includes("dup-webhooks") && this.rng() < this.chaos.rate;
    const shuffle = !!this.chaos?.modes.includes("out-of-order");
    const retries = this.def.webhooks?.retries ?? 2;
    const sendOnce = async (duplicate: boolean): Promise<void> => {
      if (shuffle) await sleep(Math.floor(this.rng() * 1500));
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        const { body, headers: h } = this.buildSigned(url, payload, format, headers, secret, eventId);
        const entry: LoggedDelivery = { id: eventId, at: this.nowMs(), type, url, status: null, attempt, payload: maskCards(payload), duplicate };
        try {
          const r = await f(url, { method: "POST", headers: h, body, signal: AbortSignal.timeout(10_000), redirect: "manual" });
          entry.status = r.status;
          await r.body?.cancel().catch(() => undefined);
          this.logDelivery(entry);
          if (r.status >= 200 && r.status < 300) return;
        } catch (e) {
          entry.error = (e as Error).message;
          this.logDelivery(entry);
        }
        if (attempt <= retries) await sleep(200 * 2 ** (attempt - 1) * (this.opts.autoScale ?? 1));
      }
    };
    await sendOnce(false);
    if (dup) await sendOnce(true);
  }

  private logDelivery(d: LoggedDelivery): void {
    this.deliveries.push(d);
    if (this.deliveries.length > LOG_MAX) this.deliveries.shift();
    this.notify("delivery", d);
  }

  // ---------- hosted test page actions ----------

  checkoutDef(resource: string): CheckoutDef | undefined {
    return this.def.checkout?.find((c) => c.resource === resource);
  }

  checkoutInfo(resource: string, id: string, nonce: string): { obj: Record<string, Json>; title: string; amount?: string; returnUrl?: string; canFail: boolean } | null {
    const ck = this.checkoutDef(resource);
    if (!ck) return null;
    const obj = this.store.get(resource)?.get(id);
    if (!obj || !nonce || obj.__nonce !== nonce) return null;
    let amount: string | undefined;
    const raw = ck.amountField ? obj[ck.amountField] : undefined;
    if (raw !== undefined && raw !== null) {
      const n = Number(raw);
      const shown = ck.amountMinorUnits && Number.isFinite(n) ? (n / 100).toFixed(2) : String(raw);
      amount = `${shown}${ck.currencyField && obj[ck.currencyField] ? ` ${String(obj[ck.currencyField]).toUpperCase()}` : ""}`;
    }
    const ru = ck.returnUrlField ? obj[ck.returnUrlField] : undefined;
    let ret = typeof ru === "string" ? ru.replace("{CHECKOUT_SESSION_ID}", encodeURIComponent(id)) : undefined;
    if (ret && ck.returnQuery) {
      try {
        const u = new URL(ret);
        const qctx = { obj: this.output(resource, obj, []) };
        for (const [k, t] of Object.entries(ck.returnQuery)) u.searchParams.set(k, String(render(t, qctx) ?? ""));
        ret = u.toString();
      } catch { /* leave as is */ }
    }
    return { obj, title: ck.title ?? `${this.def.title} test payment`, amount, canFail: !!ck.fail, returnUrl: ret && isLoopbackUrl(ret, this.opts.allowWebhookHosts) ? ret : undefined };
  }

  checkoutAction(resource: string, id: string, nonce: string, action: "succeed" | "fail"): { ok: boolean; returnUrl?: string; message: string } {
    const info = this.checkoutInfo(resource, id, nonce);
    const ck = this.checkoutDef(resource);
    if (!info || !ck) return { ok: false, message: "This test page has expired or the link is wrong." };
    const transition = action === "succeed" ? ck.succeed : ck.fail;
    if (!transition) return { ok: false, message: "This twin has no failure path for this page." };
    const ctx = this.baseCtx({}, {}, {}, {}, String(info.obj.__key ?? ""));
    const r = this.runTransition(resource, info.obj, transition, ctx, {});
    info.obj.__nonce = randomAlnum(20); // one use
    this.notify("state", null);
    if (r.error) return { ok: false, message: renderString(r.error.message, { ...ctx, ...r.vars }) as string };
    return { ok: true, returnUrl: info.returnUrl, message: action === "succeed" ? "Test payment approved." : "Test payment declined." };
  }

  // ---------- responses ----------

  private errSpec(kind: keyof NonNullable<NonNullable<TwinDefinition["conventions"]>["errors"]>, fallback: ErrorSpec): ErrorSpec {
    return this.def.conventions?.errors?.[kind] ?? fallback;
  }

  private errorResponse(spec: ErrorSpec, vars: Record<string, Json>): TwinResponse {
    const ctx: EvalContext = { ...vars, $status: vars.$status ?? spec.status, fns: ERROR_FNS };
    const message = vars.$message ?? renderString(spec.message, ctx);
    const full: EvalContext = {
      ...ctx,
      $message: message as Json,
      $code: (spec.code ? renderString(spec.code, ctx) : null) as Json,
      $type: (spec.type ?? null) as Json,
      $param: (vars.$param ?? (spec.param ? renderString(spec.param, ctx) : null)) as Json,
    };
    for (const [k, t] of Object.entries(spec.extra ?? {})) full[`$${k}`] = render(t, full);
    const tpl = this.def.conventions?.error ?? { error: { message: "{{$message}}", code: "{{$code}}", type: "{{$type}}", param: "{{$param}}" } };
    let body = render(tpl, full);
    if (spec.extra && body && typeof body === "object" && !Array.isArray(body)) {
      // put extras next to `message` wherever the template nests it
      const host = findMessageHost(body as Record<string, Json>);
      for (const k of Object.keys(spec.extra)) host[k] = full[`$${k}`] as Json;
      body = plain(body);
    }
    if (this.def.conventions?.errorDropNulls) body = dropNulls(body);
    const status = Number(full.$status) || spec.status;
    return this.json(status, body);
  }

  /** Server-sent events built from the created object, sent in one response (clients read them as a stream). */
  private streamResponse(sd: NonNullable<OperationDef["stream"]>, resource: string, ctx: EvalContext): TwinResponse {
    const obj = ctx.obj as Record<string, Json>;
    const data = this.output(resource, obj, []);
    const sctx = { ...ctx, $data: data, obj: data } as EvalContext;
    const events = sd.cases?.find((c) => evalCondition(c.when, sctx))?.events ?? sd.events;
    let body = "";
    for (const t of events) {
      const ev = render(t, sctx);
      const name = sd.eventField && ev && typeof ev === "object" && !Array.isArray(ev) ? (ev as Record<string, Json>)[sd.eventField] : undefined;
      if (typeof name === "string") body += `event: ${name}\n`;
      body += `data: ${JSON.stringify(ev)}\n\n`;
    }
    if (sd.done) body += `data: ${sd.done}\n\n`;
    return { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" }, body };
  }

  private json(status: number, body: Json): TwinResponse {
    return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  }

  private withHeaders(r: TwinResponse, h: Record<string, string>): TwinResponse {
    return { ...r, headers: { ...r.headers, ...h } };
  }
}

const ERROR_FNS: Record<string, (...a: Json[]) => Json> = {
  int: (x) => Math.trunc(Number(x) || 0),
  upper: (x) => String(x ?? "").toUpperCase(),
  lower: (x) => String(x ?? "").toLowerCase(),
  concat: (...xs) => xs.map((x) => (x === null || x === undefined ? "" : String(x))).join(""),
};

function findMessageHost(o: Record<string, Json>): Record<string, Json> {
  if ("message" in o) return o;
  for (const v of Object.values(o)) if (v && typeof v === "object" && !Array.isArray(v) && "message" in v) return v as Record<string, Json>;
  return o;
}

function lookupField(o: Record<string, Json>, path: string): Json | undefined {
  let cur: Json | undefined = o;
  for (const p of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, Json>)[p];
  }
  return cur;
}

function specificity(path: string): number {
  const segs = path.split("/").filter(Boolean);
  // more segments first; among equal length, more literal segments first
  return segs.length * 100 + segs.filter((s) => !s.includes("{")).length;
}

function basicKey(h: string): string {
  const m = h.match(/^Basic\s+(.+)$/i);
  if (!m) return "";
  try {
    const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return decoded;
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    return pass || user;
  } catch {
    return "";
  }
}

function lower(h: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  return o;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }); }

/** Remove null fields from objects (two levels deep: error bodies are shallow). */
function dropNulls(v: Json, depth = 0): Json {
  if (!v || typeof v !== "object" || Array.isArray(v) || depth > 3) return v;
  const out: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) out[k] = dropNulls(x, depth + 1);
  return out;
}
