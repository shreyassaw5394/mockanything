/**
 * OpenAPI 3.x / Swagger 2.0 → twin definition.
 *
 * Inference, in order:
 *   1. Paths are grouped into resources: `/things` + `/things/{id}` is a collection with items;
 *      `/things/{id}/cancel` (POST, no list) is a state transition; nested paths are scoped by their params.
 *   2. Object shapes come from response schemas (examples first), so created objects look real.
 *   3. `status`/`state` enums become lifecycles; action paths map to the matching enum value.
 *   4. Envelopes (`{ data: [...] , has_more }`, `{ status, message, data }`), pagination style,
 *      error shape, auth and OAS 3.1 `webhooks` are read from the spec.
 * Every guess is recorded in the report so people (and agents) can see and override it.
 */
import type { Json, OperationDef, ResourceDef, Template, TwinDefinition, EmitDef } from "../engine/types.js";
import { validateDefinition } from "../engine/schema.js";
import { singularize } from "../engine/util.js";

type Schema = Record<string, unknown>;
type Doc = Record<string, unknown>;

export interface InferenceReport {
  title: string;
  version: string;
  resources: { name: string; idField: string; idStyle: string; lifecycle?: string; transitions: string[]; scope: string[] }[];
  operations: { total: number; byAction: Record<string, number>; skipped: number };
  auth: string;
  listStyle: string;
  webhooks: number;
  guesses: string[];
}

export interface IngestResult { def: TwinDefinition; report: InferenceReport }

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MAX_PATHS = 5000;
const MAX_DEPTH = 6;

const VERB_TARGETS: Record<string, string[]> = {
  confirm: ["succeeded", "confirmed", "complete", "completed", "paid"],
  capture: ["succeeded", "captured", "paid"],
  cancel: ["canceled", "cancelled", "void", "voided"],
  void: ["void", "voided", "canceled", "cancelled"],
  refund: ["refunded"],
  close: ["closed"],
  reopen: ["open", "opened", "reopened"],
  archive: ["archived"],
  unarchive: ["active", "open"],
  approve: ["approved", "accepted"],
  accept: ["accepted", "approved"],
  reject: ["rejected", "declined", "denied"],
  decline: ["declined", "rejected"],
  complete: ["completed", "complete", "done", "finished"],
  finish: ["finished", "completed", "complete"],
  finalize: ["finalized", "open"],
  finalise: ["finalised", "finalized", "open"],
  pay: ["paid", "succeeded"],
  send: ["sent", "delivered"],
  publish: ["published", "live"],
  unpublish: ["draft", "unpublished"],
  activate: ["active", "activated", "enabled"],
  enable: ["enabled", "active"],
  resume: ["active", "running", "resumed"],
  start: ["running", "started", "active", "in_progress"],
  deactivate: ["inactive", "deactivated", "disabled"],
  disable: ["disabled", "inactive"],
  pause: ["paused", "suspended"],
  suspend: ["suspended", "paused"],
  stop: ["stopped", "halted"],
  verify: ["verified"],
  submit: ["submitted", "pending"],
  lock: ["locked"],
  unlock: ["unlocked", "open"],
  expire: ["expired"],
  mark_uncollectible: ["uncollectible"],
  release: ["released"],
  ship: ["shipped"],
  fulfill: ["fulfilled"],
  deliver: ["delivered"],
  merge: ["merged", "closed"],
  resolve: ["resolved", "closed"],
};

const RPC_LIST = /^(find|search|list|query|filter|lookup_all|all)(_|$)|^find_by|^list_/;
const RPC_CREATE = /^(initialize|initialise|init|create|add|new|register|charge(_|$)|charge_authorization|partial_debit|send|submit_order|open|start_session)$/;
const RPC_READ = /^(verify|fetch|get|retrieve|lookup|status|find|show|details)$/;
const LIMIT_PARAMS = ["limit", "per_page", "perPage", "page_size", "pageSize", "PageSize", "size", "count", "max_results", "maxResults", "top", "$top"];
const CURSOR_PARAMS = ["starting_after", "after", "cursor", "next", "page_token", "pageToken", "next_token", "continuation", "offset_id"];
const PAGE_PARAMS = ["page", "Page", "page_number", "pageNumber", "offset"];

export function ingestOpenApi(doc: unknown, sourceUrl?: string): IngestResult {
  if (!doc || typeof doc !== "object") throw new Error("Not an OpenAPI document");
  const d = doc as Doc;
  const isV3 = typeof d.openapi === "string" && d.openapi.startsWith("3");
  const isV2 = d.swagger === "2.0";
  if (!isV3 && !isV2) throw new Error("Not an OpenAPI 3.x or Swagger 2.0 document (missing `openapi` or `swagger` field)");
  const paths = (d.paths ?? {}) as Record<string, Record<string, unknown>>;
  const pathKeys = Object.keys(paths).slice(0, MAX_PATHS);
  const guesses: string[] = [];
  if (Object.keys(paths).length > MAX_PATHS) guesses.push(`Only the first ${MAX_PATHS} paths were used.`);

  const R = new Resolver(d);
  const info = (d.info ?? {}) as Record<string, unknown>;
  const title = String(info.title ?? "API").slice(0, 120);
  const id = slug(title) || "api";

  // ---- base path ----
  let basePath = "";
  if (isV3) {
    const servers = (d.servers as { url?: string; variables?: Record<string, { default?: string }> }[] | undefined) ?? [];
    const s = servers[0];
    if (s?.url) {
      let u = s.url;
      for (const [k, v] of Object.entries(s.variables ?? {})) u = u.replaceAll(`{${k}}`, String(v.default ?? ""));
      try { basePath = new URL(u, "http://x").pathname; } catch { basePath = ""; }
    }
  } else {
    basePath = String(d.basePath ?? "");
  }
  basePath = basePath.replace(/\/+$/, "");
  if (basePath === "/") basePath = "";

  // ---- collect raw operations ----
  interface RawOp { method: string; path: string; op: Record<string, unknown>; segs: string[] }
  const raw: RawOp[] = [];
  for (const p of pathKeys) {
    const item = R.deref(paths[p]) as Record<string, unknown> | undefined;
    if (!item) continue;
    for (const m of METHODS) {
      const op = item[m] as Record<string, unknown> | undefined;
      if (op && typeof op === "object") raw.push({ method: m.toUpperCase(), path: p, op: { ...op, __pathParams: item.parameters }, segs: p.split("/").filter(Boolean) });
    }
  }
  const pathSet = new Set(pathKeys);
  const hasGet = (p: string) => !!(paths[p] && (R.deref(paths[p]) as Record<string, unknown>)?.get);
  const isParam = (seg: string) => /^\{[^}]+\}(\.json)?$/.test(seg);
  const paramName = (seg: string) => seg.replace(/^\{/, "").replace(/\}(\.json)?$/, "");
  const segName = (seg: string) => seg.replace(/\.json$/i, "");

  // ---- classify ----
  interface Classified { r: RawOp; kind: "collection" | "item" | "action" | "static"; resourceKey?: string; collectionPath?: string; idParam?: string; verb?: string; finder?: boolean; rpc?: string; lookupParam?: string }
  const classified: Classified[] = [];
  for (const r of raw) {
    const segs = r.segs;
    const last = segs.at(-1);
    if (!last) { classified.push({ r, kind: "static" }); continue; }
    if (isParam(last)) {
      const prev = segs.at(-2);
      if (!prev || isParam(prev)) { classified.push({ r, kind: "static" }); continue; }
      const prev2 = segs.at(-3);
      const prevVerb = segName(prev).toLowerCase();
      if (prev2 && !isParam(prev2) && r.method === "GET" && RPC_READ.test(prevVerb) && !pathKeys.some((k) => k === "/" + segs.slice(0, -1).join("/"))) {
        classified.push({ r, kind: "item", resourceKey: resourceKeyOf(prev2), collectionPath: "/" + segs.slice(0, -2).join("/"), idParam: paramName(last), lookupParam: paramName(last) });
        continue;
      }
      const collectionPath = "/" + segs.slice(0, -1).join("/");
      classified.push({ r, kind: "item", resourceKey: resourceKeyOf(prev), collectionPath, idParam: paramName(last) });
      continue;
    }
    const prev = segs.at(-2);
    // `/pets/findByStatus`, `/customers/search`, `/transaction/initialize`, `/transaction/verify/{ref}`
    if (prev && !isParam(prev)) {
      const verbSeg = segName(last).replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const parentPath = "/" + segs.slice(0, -1).join("/");
      const parentIsCollection = pathKeys.some((k) => k === parentPath || k.startsWith(parentPath + "/{")) || segs.length >= 2;
      if (parentIsCollection && r.method === "GET" && RPC_LIST.test(verbSeg)) {
        classified.push({ r, kind: "collection", resourceKey: resourceKeyOf(prev), collectionPath: parentPath, finder: true });
        continue;
      }
      if (parentIsCollection && r.method === "POST" && RPC_CREATE.test(verbSeg) && !pathKeys.some((k) => k.startsWith(r.path + "/"))) {
        classified.push({ r, kind: "collection", resourceKey: resourceKeyOf(prev), collectionPath: parentPath, rpc: verbSeg });
        continue;
      }
    }
    if (prev && isParam(prev)) {
      const p = r.path;
      const hasItemsBelow = pathKeys.some((k) => k.startsWith(p + "/{"));
      const isCollection = hasItemsBelow || hasGet(p) || (r.method !== "POST");
      const looksVerb = !!verbOf(segName(last)) || !/s$/i.test(segName(last));
      if (!isCollection && r.method === "POST" && looksVerb && segs.at(-3) && !isParam(segs.at(-3)!)) {
        const parentCollection = "/" + segs.slice(0, -2).join("/");
        classified.push({ r, kind: "action", resourceKey: resourceKeyOf(segs.at(-3)!), collectionPath: parentCollection, idParam: paramName(prev), verb: segName(last) });
        continue;
      }
    }
    classified.push({ r, kind: "collection", resourceKey: resourceKeyOf(last), collectionPath: r.path });
  }
  void pathSet;

  // ---- resources ----
  const resources: Record<string, ResourceDef> = {};
  const operations: OperationDef[] = [];
  const reportRes: InferenceReport["resources"] = [];
  const byAction: Record<string, number> = {};
  const listParamsSeen: string[] = [];
  const resourceKeys = [...new Set(classified.filter((c) => c.resourceKey).map((c) => c.resourceKey!))];

  const objectSchemaFor = new Map<string, Schema | undefined>();
  for (const key of resourceKeys) {
    const group = classified.filter((c) => c.resourceKey === key);
    // the object shape: item GET response, else create response, else list item
    let objSchema: Schema | undefined;
    for (const c of group.filter((g) => g.kind === "item" && g.r.method === "GET")) objSchema ??= unwrapSingle(R, responseSchema(R, c.r.op, isV3)).inner;
    for (const c of group.filter((g) => g.kind === "collection" && g.r.method === "POST")) objSchema ??= unwrapSingle(R, responseSchema(R, c.r.op, isV3)).inner;
    for (const c of group.filter((g) => g.kind === "collection" && g.r.method === "GET")) objSchema ??= unwrapList(R, responseSchema(R, c.r.op, isV3)).item;
    objectSchemaFor.set(key, objSchema);
  }

  for (const key of resourceKeys) {
    const group = classified.filter((c) => c.resourceKey === key);
    const objSchema = objectSchemaFor.get(key);
    const props = R.properties(objSchema);
    const singular = singularize(key);
    const itemParam = group.find((g) => g.idParam)?.idParam;
    const idField = props.id ? "id" : (itemParam && Object.keys(props).find((k) => k.toLowerCase() === itemParam.toLowerCase())) || (props.uuid ? "uuid" : "id");
    const idDef = inferId(R, props[idField], idField);
    const scope = [...new Set(group.flatMap((g) => (g.collectionPath ?? "").split("/").filter(isParam).map(paramName)))];

    const defaults: Record<string, Template> = {};
    const synth = synthesize(R, objSchema, 0, new Set()) as Record<string, Json> | null;
    if (synth && typeof synth === "object" && !Array.isArray(synth)) {
      for (const [k, v] of Object.entries(synth)) if (k !== idField) defaults[k] = v;
    }
    // timestamps
    const onUpdate: Record<string, Template> = {};
    for (const [k, s] of Object.entries(props)) {
      const sch = R.resolve(s);
      const isTime = /^(created|created_at|createdat|creation_time|date_created|inserted_at|timestamp|updated|updated_at|updatedat|date_updated|modified|modified_at|last_modified)$/i.test(k);
      if (!isTime) continue;
      const t = typeOf(sch);
      const tpl = t === "integer" || t === "number" ? "{{nowUnix}}" : "{{nowIso}}";
      defaults[k] = tpl;
      if (/updat|modif/i.test(k)) onUpdate[k] = tpl;
    }
    // copy path params onto objects when the object has a field of the same name (e.g. `owner`, `repo`)
    // lifecycle
    let lifecycle: ResourceDef["lifecycle"];
    const stateField = ["status", "state", "phase", "lifecycle_state"].find((f) => {
      const s = R.resolve(props[f]);
      return Array.isArray(s?.enum) && (s!.enum as unknown[]).length >= 2;
    });
    const transitions: string[] = [];
    if (stateField) {
      const sch = R.resolve(props[stateField])!;
      const values = (sch.enum as unknown[]).map(String);
      const preferred = ["requires_payment_method", "draft", "pending", "created", "new", "queued", "open", "incomplete", "initiated", "requires_confirmation", "processing", "active", "enabled", "unpaid"];
      const initial = sch.default !== undefined ? String(sch.default) : (preferred.find((v) => values.includes(v)) ?? values[0]!);
      if (sch.default === undefined) guesses.push(`${key}: starts in ${stateField} "${initial}".`);
      lifecycle = { field: stateField, initial, transitions: {} };
      for (const g of group.filter((x) => x.kind === "action")) {
        const verb = g.verb!;
        const target = matchTarget(verb, values);
        const tname = slug(verb).replace(/-/g, "_") || "action";
        lifecycle.transitions[tname] = target ? { to: target } : {};
        transitions.push(target ? `${tname} → ${target}` : `${tname} (no state change: no matching ${stateField} value)`);
        if (!target) guesses.push(`${key}: "${verb}" has no matching ${stateField} value, so it returns the object unchanged.`);
      }
      delete defaults[stateField];
    } else if (group.some((g) => g.kind === "action")) {
      lifecycle = { field: "__state", initial: "created", transitions: {} };
      for (const g of group.filter((x) => x.kind === "action")) lifecycle.transitions[slug(g.verb!).replace(/-/g, "_") || "action"] = {};
    }

    // request body: required + types
    const createOp = group.find((g) => g.kind === "collection" && g.r.method === "POST");
    const body = createOp ? requestSchema(R, createOp.r.op, isV3) : undefined;
    const bodyProps = R.properties(body);
    const required = Array.isArray(R.resolve(body)?.required) ? (R.resolve(body)!.required as string[]).filter((f) => typeof f === "string").slice(0, 50) : [];
    const types: ResourceDef["types"] = {};
    for (const [k, s] of Object.entries({ ...props, ...bodyProps })) {
      const t = typeOf(R.resolve(s));
      if (t === "integer" || t === "number" || t === "boolean" || t === "array" || t === "object") types[k] = t;
    }

    const def: ResourceDef = { singular, id: idDef, defaults, types, accept: "*", readonly: idField === "id" ? [] : [idField] };
    if (required.length) def.required = required;
    if (Object.keys(onUpdate).length) def.onUpdate = onUpdate;
    if (lifecycle) def.lifecycle = lifecycle;
    if (scope.length) def.scope = scope;
    if (idField !== "id") def.id = { ...idDef, field: idField };
    resources[key] = def;
    reportRes.push({ name: key, idField, idStyle: `${idDef.style}${idDef.prefix ? ` (${idDef.prefix})` : ""}`, lifecycle: lifecycle && lifecycle.field !== "__state" ? lifecycle.field : undefined, transitions, scope });
  }

  // refs + filters need every resource
  const singularToKey = new Map(Object.keys(resources).map((k) => [singularize(k), k]));
  for (const [key, def] of Object.entries(resources)) {
    const props = R.properties(objectSchemaFor.get(key));
    const refs: Record<string, string> = {};
    for (const [k, s] of Object.entries(props)) {
      if (typeOf(R.resolve(s)) !== "string") continue;
      const base = k.replace(/(_id|Id)$/, "");
      const target = singularToKey.get(base) ?? singularToKey.get(singularize(base));
      if (target && target !== key) refs[k] = target;
    }
    if (Object.keys(refs).length) def.refs = refs;
  }

  // ---- operations ----
  const envelopeSingle = new Map<string, Template>();
  for (const c of classified) {
    const r = c.r;
    const path = r.path.replace(/\.json$/i, ".json");
    let op: OperationDef;
    if (c.kind === "static" || !c.resourceKey) {
      const s = responseSchema(R, r.op, isV3);
      op = { method: r.method, path, action: "static", response: { status: successStatus(r.op), body: exampleFor(R, r.op, isV3) ?? (synthesize(R, s, 0, new Set()) as Template) } };
    } else {
      const key = c.resourceKey;
      const resp = responseSchema(R, r.op, isV3);
      if (c.kind === "collection" && r.method === "GET") {
        const { envelope } = unwrapList(R, resp);
        op = { method: r.method, path, action: "list", resource: key };
        if (envelope !== undefined) op.response = { body: envelope };
        const qp = queryParams(R, r.op, isV3);
        listParamsSeen.push(...qp);
        const props = R.properties(objectSchemaFor.get(key));
        const filters: Record<string, string> = {};
        for (const q of qp) if (props[q] && !LIMIT_PARAMS.includes(q) && !CURSOR_PARAMS.includes(q) && !PAGE_PARAMS.includes(q)) filters[q] = q;
        if (Object.keys(filters).length) resources[key]!.filters = { ...resources[key]!.filters, ...filters };
      } else if (c.kind === "collection" && r.method === "PUT" && classified.some((x) => x.resourceKey === key && x.kind === "collection" && x.r.method === "POST" && x.r.path === r.path)) {
        const { envelope } = unwrapSingle(R, resp);
        const idf = resources[key]!.id?.field ?? "id";
        op = { method: r.method, path, action: "update", resource: key, lookup: { fields: [idf], from: `{{body.${idf}}}` } };
        if (envelope !== undefined) op.response = { body: envelope };
      } else if (c.kind === "collection" && (r.method === "POST" || r.method === "PUT")) {
        const { envelope } = unwrapSingle(R, resp);
        op = { method: r.method, path, action: "create", resource: key };
        const status = successStatus(r.op);
        op.response = { status, ...(envelope !== undefined ? { body: envelope } : {}) };
        if (envelope !== undefined) envelopeSingle.set(key, envelope);
      } else if (c.kind === "item" && r.method === "GET") {
        const { envelope } = unwrapSingle(R, resp);
        op = { method: r.method, path, action: "read", resource: key, idParam: c.idParam };
        if (envelope !== undefined) { op.response = { body: envelope }; envelopeSingle.set(key, envelope); }
      } else if (c.kind === "item" && (r.method === "PUT" || r.method === "PATCH" || r.method === "POST")) {
        const { envelope } = unwrapSingle(R, resp);
        op = { method: r.method, path, action: "update", resource: key, idParam: c.idParam };
        if (envelope !== undefined) op.response = { body: envelope };
      } else if (c.kind === "item" && r.method === "DELETE") {
        const status = successStatus(r.op);
        op = { method: r.method, path, action: "delete", resource: key, idParam: c.idParam, response: { status } };
        if (status !== 204) {
          const s = R.properties(R.resolve(resp));
          if (s.deleted) op.response = { status, body: { ...(synthesize(R, R.resolve(resp), 0, new Set()) as Record<string, Json>), id: "{{obj.id}}", deleted: true } };
          else op.response = { status, body: "{{$data}}" };
        }
      } else if (c.kind === "action") {
        const tname = slug(c.verb!).replace(/-/g, "_") || "action";
        const { envelope } = unwrapSingle(R, resp);
        op = { method: r.method, path, action: "transition", resource: key, transition: tname, idParam: c.idParam };
        if (envelope !== undefined) op.response = { body: envelope };
      } else {
        const s = responseSchema(R, r.op, isV3);
        op = { method: r.method, path, action: "static", response: { status: successStatus(r.op), body: exampleFor(R, r.op, isV3) ?? (synthesize(R, s, 0, new Set()) as Template) } };
      }
    }
    if (c.idParam && op.resource && (op.action === "read" || op.action === "update" || op.action === "delete" || op.action === "transition") && !op.lookup) {
      const res = resources[op.resource]!;
      const idf = res.id?.field ?? "id";
      const norm = (x: string) => x.toLowerCase().replace(/[_-]/g, "");
      const generic = /^(id|.*_id|.*Id|sid|uuid|key|slug)$/.test(c.idParam) && norm(c.idParam).endsWith(norm(idf));
      if (!generic || c.lookupParam) {
        const props = Object.keys(R.properties(objectSchemaFor.get(op.resource)));
        const parts = c.idParam.split(/_or_|Or(?=[A-Z])/);
        const fields = [idf, ...props.filter((p) => p !== idf && (parts.some((q) => norm(q) === norm(p)) || norm(p) === norm(c.idParam!) || (p.length >= 3 && norm(c.idParam!).endsWith(norm(p)))))];
        if (fields.length > 1 || c.lookupParam) {
          op.lookup = { fields: [...new Set(fields)].slice(0, 10), from: `{{params.${c.idParam}}}` };
          // integer handles like GitHub's issue `number` count up per scope instead of repeating the spec example
          for (const f of fields.slice(1)) {
            const sch = R.resolve(R.properties(objectSchemaFor.get(op.resource))[f]);
            if (typeOf(sch) === "integer" && res.defaults) res.defaults[f] = "{{seq()}}";
          }
        }
      }
    }
    if (typeof r.op.summary === "string") op.summary = r.op.summary.slice(0, 500);
    operations.push(op);
    byAction[op.action] = (byAction[op.action] ?? 0) + 1;
  }

  // ---- pagination style ----
  const countOf = (n: string) => listParamsSeen.filter((x) => x === n).length;
  const best = (names: string[]) => names.map((n) => [n, countOf(n)] as const).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])[0];
  const cursorBest = best(CURSOR_PARAMS);
  const pageBest = best(PAGE_PARAMS);
  const cursor = cursorBest?.[0];
  const page = pageBest?.[0];
  const limitParam = best(LIMIT_PARAMS)?.[0] ?? "limit";
  const listStyle = cursorBest && (!pageBest || cursorBest[1] >= pageBest[1])
    ? { kind: "cursor" as const, limitParam, afterParam: cursor, defaultLimit: 10, maxLimit: 100 }
    : { kind: "page" as const, limitParam, pageParam: page ?? "page", pageBase: (page === "offset" ? 0 : 1) as 0 | 1, defaultLimit: 20, maxLimit: 100 };

  // ---- auth ----
  const auth = inferAuth(d, isV3);

  // ---- errors ----
  const error = inferErrorTemplate(R, raw.map((x) => x.op), isV3);

  // ---- webhooks (OAS 3.1) ----
  const webhooks = (d.webhooks ?? {}) as Record<string, Record<string, unknown>>;
  let webhookCount = 0;
  for (const [name, item] of Object.entries(webhooks).slice(0, 500)) {
    const post = (R.deref(item) as Record<string, unknown> | undefined)?.post as Record<string, unknown> | undefined;
    if (!post) continue;
    const bind = bindWebhook(name, resources);
    if (!bind) continue;
    const payloadSchema = requestSchema(R, post, true);
    const payload = webhookPayload(R, payloadSchema, bind.resource);
    const emit: EmitDef = payload ? { type: name, payload } : name;
    for (const op of operations) {
      if (op.resource !== bind.resource) continue;
      const match = (bind.action === "created" && op.action === "create") || (bind.action === "updated" && op.action === "update") || (bind.action === "deleted" && op.action === "delete");
      if (match) { (op.emit ??= []).push(emit); webhookCount++; }
    }
    if (bind.transition) {
      const lc = resources[bind.resource]?.lifecycle;
      const t = lc?.transitions[bind.transition];
      if (t) { (t.emit ??= []).push(emit); webhookCount++; }
    }
  }

  const bodyMap: Record<string, string> = {};
  const norm = (x: string) => x.toLowerCase().replace(/[_-]/g, "");
  for (const key of Object.keys(resources)) {
    const objProps = Object.keys(R.properties(objectSchemaFor.get(key)));
    const createOp = classified.find((g) => g.resourceKey === key && g.kind === "collection" && g.r.method === "POST");
    if (!createOp) continue;
    for (const bp of Object.keys(R.properties(requestSchema(R, createOp.r.op, isV3)))) {
      if (objProps.includes(bp)) continue;
      const match = objProps.find((p) => norm(p) === norm(bp));
      if (match && !bodyMap[bp]) bodyMap[bp] = match;
    }
  }
  for (const r of Object.values(resources)) {
    if (r.required) r.required = r.required.map((f) => bodyMap[f] ?? f);
    if (r.types) for (const [from, to] of Object.entries(bodyMap)) if (r.types[from] && !r.types[to]) r.types[to] = r.types[from]!;
  }

  const def: TwinDefinition = {
    schema: 1,
    id,
    title,
    description: typeof info.description === "string" ? info.description.slice(0, 2000) : undefined,
    source: { kind: "openapi", url: sourceUrl, license: typeof (info.license as Record<string, unknown> | undefined)?.name === "string" ? String((info.license as Record<string, unknown>).name).slice(0, 200) : undefined },
    inferred: true,
    fallback: "rest",
    basePath: basePath || undefined,
    auth: { ...auth, optional: true },
    conventions: {
      timestamps: "iso",
      listStyle,
      list: "{{$items}}",
      error,
      createStatus: 201,
      ...(Object.keys(bodyMap).length ? { bodyMap } : {}),
    },
    resources,
    operations,
    notes: [
      `Inferred from the ${isV3 ? `OpenAPI ${String(d.openapi)}` : "Swagger 2.0"} description: ${Object.keys(resources).length} resources, ${operations.length} operations.`,
      "State is kept in memory: create something, then read, list, update or delete it. Run `mockanything inspect` to see every guess and override it.",
      "Paths the spec doesn't describe still work as generic REST (responses carry `x-mockanything-fallback: rest`).",
    ],
  };
  if (webhookCount) def.webhooks = { signing: { scheme: "hmac-sha256-hex", header: "x-mockanything-signature" }, retries: 2 };
  const validated = validateDefinition(def);
  return {
    def: validated,
    report: {
      title, version: String(info.version ?? ""), resources: reportRes,
      operations: { total: operations.length, byAction, skipped: raw.length - operations.length },
      auth: auth.type + (auth.name ? ` (${auth.name})` : ""),
      listStyle: `${listStyle.kind} (${listStyle.kind === "cursor" ? `${limitParam}, ${cursor}` : `${limitParam}, ${listStyle.pageParam}`})`,
      webhooks: webhookCount,
      guesses,
    },
  };
}

// ---------------- helpers ----------------

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function resourceKeyOf(seg: string): string {
  return seg.replace(/\.json$/i, "").replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_]+/g, "_").toLowerCase().replace(/^_+|_+$/g, "") || "items";
}

function verbOf(seg: string): string | undefined {
  const s = seg.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  if (VERB_TARGETS[s]) return s;
  const parts = s.split(/[_-]/);
  return parts.find((p) => VERB_TARGETS[p]);
}

function matchTarget(verbSeg: string, values: string[]): string | undefined {
  const lower = values.map((v) => v.toLowerCase());
  const v = verbOf(verbSeg);
  for (const cand of v ? VERB_TARGETS[v] ?? [] : []) {
    const i = lower.indexOf(cand);
    if (i >= 0) return values[i];
  }
  const stem = verbSeg.toLowerCase().replace(/e$/, "");
  const i = lower.findIndex((x) => x.startsWith(stem));
  return i >= 0 ? values[i] : undefined;
}

class Resolver {
  private cache = new Map<string, unknown>();
  constructor(private doc: Doc) {}
  deref(node: unknown, depth = 0): unknown {
    if (!node || typeof node !== "object") return node;
    const ref = (node as Record<string, unknown>).$ref;
    if (typeof ref !== "string") return node;
    if (depth > 20) return undefined;
    if (!ref.startsWith("#/")) return undefined; // external refs are never fetched
    if (this.cache.has(ref)) return this.deref(this.cache.get(ref), depth + 1);
    let cur: unknown = this.doc;
    for (const raw of ref.slice(2).split("/")) {
      const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (k === "__proto__" || !cur || typeof cur !== "object") { cur = undefined; break; }
      cur = (cur as Record<string, unknown>)[k];
    }
    this.cache.set(ref, cur);
    return this.deref(cur, depth + 1);
  }
  /** Resolve refs and flatten allOf; oneOf/anyOf pick the first object-like branch. */
  resolve(node: unknown, depth = 0): Schema | undefined {
    const s = this.deref(node) as Schema | undefined;
    if (!s || typeof s !== "object" || depth > MAX_DEPTH) return s;
    if (Array.isArray(s.allOf)) {
      const merged: Schema = { ...s, allOf: undefined, type: s.type ?? "object", properties: { ...(s.properties as Schema | undefined) }, required: [...((s.required as string[]) ?? [])] };
      for (const part of s.allOf as unknown[]) {
        const p = this.resolve(part, depth + 1);
        if (!p) continue;
        Object.assign(merged.properties as Schema, (p.properties as Schema) ?? {});
        (merged.required as string[]).push(...(((p.required as string[]) ?? [])));
        for (const k of ["example", "description", "enum", "format"]) if (p[k] !== undefined && merged[k] === undefined) merged[k] = p[k];
      }
      return merged;
    }
    for (const k of ["oneOf", "anyOf"]) {
      const list = s[k] as unknown[] | undefined;
      if (Array.isArray(list) && list.length && !s.properties) {
        const branches = list.map((b) => this.resolve(b, depth + 1)).filter(Boolean) as Schema[];
        const pick = branches.find((b) => typeOf(b) === "object") ?? branches.find((b) => typeOf(b) !== "null") ?? branches[0];
        if (pick) return { ...pick, nullable: branches.some((b) => typeOf(b) === "null") || pick.nullable };
      }
    }
    return s;
  }
  properties(node: unknown): Record<string, unknown> {
    const s = this.resolve(node);
    const p = s?.properties;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  }
}

function typeOf(s: Schema | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.type;
  if (Array.isArray(t)) return (t.find((x) => x !== "null") as string | undefined) ?? "null";
  if (typeof t === "string") return t;
  if (s.properties) return "object";
  if (s.items) return "array";
  return undefined;
}

function successStatus(op: Record<string, unknown>): number {
  const codes = Object.keys((op.responses as Record<string, unknown>) ?? {}).filter((c) => /^2\d\d$/.test(c)).map(Number).sort();
  return codes[0] ?? 200;
}

function responseSchema(R: Resolver, op: Record<string, unknown>, isV3: boolean): Schema | undefined {
  const responses = (op.responses ?? {}) as Record<string, unknown>;
  const code = Object.keys(responses).filter((c) => /^2\d\d$/.test(c)).sort()[0] ?? (responses.default ? "default" : undefined);
  if (!code) return undefined;
  const res = R.deref(responses[code]) as Record<string, unknown> | undefined;
  if (!res) return undefined;
  if (!isV3) return R.resolve(res.schema);
  const content = (res.content ?? {}) as Record<string, Record<string, unknown>>;
  const mt = Object.keys(content).find((k) => k.includes("json")) ?? Object.keys(content)[0];
  return mt ? R.resolve(content[mt]?.schema) : undefined;
}

function exampleFor(R: Resolver, op: Record<string, unknown>, isV3: boolean): Template | undefined {
  const responses = (op.responses ?? {}) as Record<string, unknown>;
  const code = Object.keys(responses).filter((c) => /^2\d\d$/.test(c)).sort()[0];
  if (!code) return undefined;
  const res = R.deref(responses[code]) as Record<string, unknown> | undefined;
  if (!res) return undefined;
  if (!isV3) return (res.examples as Record<string, Template> | undefined)?.["application/json"];
  const content = (res.content ?? {}) as Record<string, Record<string, unknown>>;
  const mt = Object.keys(content).find((k) => k.includes("json"));
  const m = mt ? content[mt] : undefined;
  if (!m) return undefined;
  if (m.example !== undefined) return sanitizeExample(m.example);
  const exs = m.examples as Record<string, { value?: unknown }> | undefined;
  const first = exs ? Object.values(exs)[0] : undefined;
  return first?.value !== undefined ? sanitizeExample((R.deref(first) as { value?: unknown })?.value) : undefined;
}

function sanitizeExample(v: unknown, depth = 0): Template {
  if (depth > 8) return null;
  if (v === null || typeof v === "number" || typeof v === "boolean") return v as Json;
  if (typeof v === "string") return v.replace(/\{\{/g, "{ {").slice(0, 2000);
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitizeExample(x, depth + 1));
  if (typeof v === "object") {
    const o: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 200)) if (k !== "__proto__") o[k] = sanitizeExample(x, depth + 1) as Json;
    return o;
  }
  return null;
}

function requestSchema(R: Resolver, op: Record<string, unknown>, isV3: boolean): Schema | undefined {
  if (isV3) {
    const rb = R.deref(op.requestBody) as Record<string, unknown> | undefined;
    const content = (rb?.content ?? {}) as Record<string, Record<string, unknown>>;
    const mt = Object.keys(content).find((k) => k.includes("json")) ?? Object.keys(content).find((k) => k.includes("form")) ?? Object.keys(content)[0];
    return mt ? R.resolve(content[mt]?.schema) : undefined;
  }
  const params = [...((op.parameters as unknown[]) ?? []), ...((op.__pathParams as unknown[]) ?? [])].map((p) => R.deref(p) as Record<string, unknown>).filter(Boolean);
  const body = params.find((p) => p.in === "body");
  if (body) return R.resolve(body.schema);
  const form = params.filter((p) => p.in === "formData");
  if (!form.length) return undefined;
  return { type: "object", properties: Object.fromEntries(form.map((p) => [String(p.name), { type: p.type }])), required: form.filter((p) => p.required).map((p) => String(p.name)) };
}

function queryParams(R: Resolver, op: Record<string, unknown>, _isV3: boolean): string[] {
  const params = [...((op.parameters as unknown[]) ?? []), ...((op.__pathParams as unknown[]) ?? [])].map((p) => R.deref(p) as Record<string, unknown>).filter(Boolean);
  return params.filter((p) => p.in === "query").map((p) => String(p.name));
}

function idLike(R: Resolver, s: Schema | undefined): boolean {
  const p = R.properties(s);
  return !!(p.id || p.uuid || p.sid || p.key);
}

/** `{ status, message, data: {...} }` → envelope with `{{$data}}` + inner schema. */
function unwrapSingle(R: Resolver, s: Schema | undefined): { inner: Schema | undefined; envelope?: Template } {
  const r = R.resolve(s);
  if (!r || typeOf(r) !== "object") return { inner: r };
  if (idLike(R, r)) return { inner: r };
  const props = R.properties(r);
  const key = ["data", "result", "object", "item", "resource"].find((k) => typeOf(R.resolve(props[k])) === "object")
    ?? Object.keys(props).find((k) => typeOf(R.resolve(props[k])) === "object" && idLike(R, R.resolve(props[k])));
  if (!key) return { inner: r };
  const env = synthesize(R, r, 0, new Set()) as Record<string, Json>;
  env[key] = "{{$data}}";
  return { inner: R.resolve(props[key]), envelope: env };
}

/** `[...]` or `{ data: [...], has_more, total }` → envelope with list placeholders + item schema. */
function unwrapList(R: Resolver, s: Schema | undefined): { item: Schema | undefined; envelope?: Template } {
  const r = R.resolve(s);
  if (!r) return { item: undefined };
  if (typeOf(r) === "array") return { item: R.resolve(r.items), envelope: undefined };
  if (typeOf(r) !== "object") return { item: undefined };
  const props = R.properties(r);
  const arrKey = ["data", "items", "results", "records", "entries", "values", "list", "content", "nodes"].find((k) => typeOf(R.resolve(props[k])) === "array")
    ?? Object.keys(props).find((k) => typeOf(R.resolve(props[k])) === "array");
  if (!arrKey) return { item: undefined };
  const env = synthesize(R, r, 0, new Set()) as Record<string, Json>;
  const fill = (o: Record<string, Json>, depth: number) => {
    for (const k of Object.keys(o)) {
      if (/^(has_more|hasmore|has_next|hasnext|has_next_page|more)$/i.test(k)) o[k] = "{{$hasMore}}";
      else if (/^(total|total_count|totalcount|count|total_results|totalresults|total_items|totalitems|totalelements)$/i.test(k)) o[k] = "{{$total}}";
      else if (/^(page|current_page|currentpage|page_number)$/i.test(k)) o[k] = "{{$page}}";
      else if (/^(per_page|perpage|page_size|pagesize|limit)$/i.test(k)) o[k] = "{{$limit}}";
      else if (/^(page_count|pagecount|total_pages|totalpages|last_page)$/i.test(k)) o[k] = "{{$pageCount}}";
      else if (/^(next|prev|previous)(_?page)?(_?(uri|url|link|token|cursor))?$|^(next|previous)_?page_?(uri|url)$/i.test(k)) o[k] = null;
      else if (/^(first_page_uri|first_page_url|uri|url|self)$/i.test(k) && depth === 0) o[k] = "{{$url}}";
      else if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) && depth < 2) fill(o[k] as Record<string, Json>, depth + 1);
    }
  };
  fill(env, 0);
  env[arrKey] = "{{$items}}";
  return { item: R.resolve(R.resolve(props[arrKey])?.items), envelope: env };
}

function inferId(R: Resolver, s: unknown, field: string): NonNullable<ResourceDef["id"]> {
  const sch = R.resolve(s);
  const t = typeOf(sch);
  if (t === "integer" || t === "number") return { style: "int" };
  const ex = sch?.example ?? (Array.isArray(sch?.examples) ? (sch!.examples as unknown[])[0] : undefined);
  if (typeof ex === "string") {
    const pre = ex.match(/^([A-Za-z]+_)([A-Za-z0-9]+)$/);
    if (pre) return { style: "prefixed", prefix: pre[1], length: Math.min(64, pre[2]!.length) };
    const twilio = ex.match(/^([A-Z]{2})([0-9a-f]{32})$/);
    if (twilio) return { style: "hex", prefix: twilio[1], length: 32 };
    if (/^[0-9a-f-]{36}$/i.test(ex)) return { style: "uuid" };
    if (/^\d+$/.test(ex)) return { style: "int" };
  }
  if (sch?.format === "uuid") return { style: "uuid" };
  const pattern = typeof sch?.pattern === "string" ? sch.pattern : "";
  const pp = pattern.match(/^\^([A-Za-z]+_)/);
  if (pp) return { style: "prefixed", prefix: pp[1], length: 24 };
  const hexp = pattern.match(/^\^([A-Z]{2})\[0-9a-fA-F\]\{(\d+)\}\$$/);
  if (hexp) return { style: "hex", prefix: hexp[1], length: Number(hexp[2]) };
  void field;
  return { style: "uuid" };
}

const NAME_HINTS: [RegExp, Json][] = [
  [/^e?mail(_address)?$|email$/i, "user@example.com"],
  [/phone|mobile|msisdn/i, "+15555550100"],
  [/^(first_?name|given_?name)$/i, "Ada"],
  [/^(last_?name|family_?name|surname)$/i, "Lovelace"],
  [/^(name|full_?name|display_?name|title|label)$/i, "Example"],
  [/^(url|uri|link|href|website|html_url|homepage)$/i, "https://example.com"],
  [/currency/i, "usd"],
  [/country/i, "US"],
  [/locale|language/i, "en"],
];

function synthesize(R: Resolver, node: unknown, depth: number, seen: Set<unknown>, name = ""): Json {
  // "expandable" fields (an id string OR the full object): start out as null, like an unset reference
  const rawNode = R.deref(node) as Schema | undefined;
  for (const k of ["anyOf", "oneOf"]) {
    const list = rawNode?.[k] as unknown[] | undefined;
    if (Array.isArray(list) && list.length > 1) {
      const kinds = list.map((b) => typeOf(R.resolve(b)));
      if (kinds.includes("string") && kinds.includes("object") && depth > 0) return null;
    }
  }
  const s = R.resolve(node);
  if (!s || depth > MAX_DEPTH) return null;
  if (seen.has(s)) return null;
  if (s.example !== undefined) return sanitizeExample(s.example) as Json;
  if (Array.isArray(s.examples) && s.examples.length) return sanitizeExample(s.examples[0]) as Json;
  if (s.default !== undefined) return sanitizeExample(s.default) as Json;
  if (s.const !== undefined) return sanitizeExample(s.const) as Json;
  if (Array.isArray(s.enum) && s.enum.length) return sanitizeExample(s.enum.find((x) => x !== null) ?? s.enum[0]) as Json;
  const t = typeOf(s);
  if (t === "object") {
    if (depth > 3) return s.nullable ? null : {};
    const props = R.properties(s);
    const out: Record<string, Json> = {};
    seen.add(s);
    for (const [k, v] of Object.entries(props).slice(0, 150)) {
      if (k === "__proto__") continue;
      out[k] = synthesize(R, v, depth + 1, seen, k);
    }
    seen.delete(s);
    return out;
  }
  if (t === "array") return [];
  if (t === "integer" || t === "number") return 0;
  if (t === "boolean") return false;
  if (t === "null") return null;
  if (t === "string") {
    if (s.format === "date-time") return "{{nowIso}}";
    if (s.format === "date") return "2026-01-01";
    if (s.format === "email") return "user@example.com";
    if (s.format === "uri" || s.format === "url") return "https://example.com";
    if (s.format === "uuid") return "{{uuid()}}";
    for (const [re, v] of NAME_HINTS) if (re.test(name)) return v;
    return s.nullable ? null : "";
  }
  return null;
}

function inferAuth(d: Doc, isV3: boolean): TwinDefinition["auth"] {
  const schemes = (isV3 ? ((d.components as Record<string, unknown> | undefined)?.securitySchemes) : d.securityDefinitions) as Record<string, Record<string, unknown>> | undefined;
  if (!schemes || !Object.keys(schemes).length) return { type: "none" };
  const globalSec = (d.security as Record<string, unknown>[] | undefined)?.[0];
  const name = (globalSec && Object.keys(globalSec)[0]) || Object.keys(schemes)[0]!;
  const s = schemes[name] ?? Object.values(schemes)[0]!;
  const type = String(s.type ?? "");
  if (type === "http" && String(s.scheme).toLowerCase() === "basic") return { type: "basic" };
  if (type === "basic") return { type: "basic" };
  if (type === "apiKey") {
    if (s.in === "query") return { type: "query", name: String(s.name ?? "api_key") };
    if (s.in === "header") {
      const n = String(s.name ?? "x-api-key");
      return n.toLowerCase() === "authorization" ? { type: "bearer" } : { type: "header", name: n };
    }
    return { type: "none" };
  }
  return { type: "bearer" };
}

function inferErrorTemplate(R: Resolver, ops: Record<string, unknown>[], isV3: boolean): Template {
  const counts = new Map<string, { n: number; schema: Schema }>();
  for (const op of ops.slice(0, 2000)) {
    const responses = (op.responses ?? {}) as Record<string, unknown>;
    for (const code of Object.keys(responses).filter((c) => /^4\d\d$/.test(c) || c === "default")) {
      const res = R.deref(responses[code]) as Record<string, unknown> | undefined;
      let sch: Schema | undefined;
      if (isV3) {
        const content = (res?.content ?? {}) as Record<string, Record<string, unknown>>;
        const mt = Object.keys(content).find((k) => k.includes("json"));
        sch = mt ? R.resolve(content[mt]?.schema) : undefined;
      } else sch = R.resolve(res?.schema);
      if (!sch || typeOf(sch) !== "object") continue;
      const key = JSON.stringify(Object.keys(R.properties(sch)).sort());
      const cur = counts.get(key) ?? { n: 0, schema: sch };
      cur.n++;
      counts.set(key, cur);
    }
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (!best) return { error: { message: "{{$message}}", code: "{{$code}}" } };
  const tpl = synthesize(R, best.schema, 0, new Set()) as Record<string, Json>;
  let placed = false;
  const fill = (o: Record<string, Json>, depth: number) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (/^(message|msg|error_description|detail|error_message|errormessage|description)$/i.test(k) && (typeof v === "string" || v === null)) { o[k] = "{{$message}}"; placed = true; }
      else if (/^(code|error_code|errorcode|type_code)$/i.test(k)) o[k] = "{{$code}}";
      else if (/^type$/i.test(k)) o[k] = "{{$type}}";
      else if (/^(status|statuscode|status_code|http_status)$/i.test(k) && (typeof v === "number" || typeof v === "string")) o[k] = typeof v === "number" ? "{{$status}}" : "{{$status}}";
      else if (/^(param|field|parameter)$/i.test(k)) o[k] = "{{$param}}";
      else if (/^error$/i.test(k) && typeof v === "string") { o[k] = "{{$message}}"; placed = true; }
      else if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) fill(v as Record<string, Json>, depth + 1);
    }
  };
  fill(tpl, 0);
  if (!placed) tpl.message = "{{$message}}";
  const prune = (o: Record<string, Json>, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (JSON.stringify(v).includes("{{$")) prune(v as Record<string, Json>, depth + 1);
        else o[k] = null;
      } else if (Array.isArray(v)) o[k] = [];
      else if (v === "" ) o[k] = null;
    }
  };
  prune(tpl, 0);
  return tpl;
}

function bindWebhook(name: string, resources: Record<string, ResourceDef>): { resource: string; action?: "created" | "updated" | "deleted"; transition?: string } | null {
  const tokens = name.toLowerCase().split(/[.\-_/:\s]+/).filter(Boolean);
  for (const [key, r] of Object.entries(resources)) {
    const sing = (r.singular ?? singularize(key)).toLowerCase();
    if (!tokens.includes(sing) && !tokens.includes(key)) continue;
    const act = tokens.find((t) => ["created", "create", "updated", "update", "deleted", "delete", "removed"].includes(t));
    if (act) return { resource: key, action: act.startsWith("creat") ? "created" : act.startsWith("updat") ? "updated" : "deleted" };
    const lc = r.lifecycle;
    if (lc) {
      for (const [tname, t] of Object.entries(lc.transitions)) {
        const to = typeof t.to === "string" ? t.to.toLowerCase() : "";
        if (tokens.includes(tname) || (to && tokens.includes(to))) return { resource: key, transition: tname };
      }
    }
  }
  return null;
}

function webhookPayload(R: Resolver, s: Schema | undefined, resource: string): Template | undefined {
  const r = R.resolve(s);
  if (!r || typeOf(r) !== "object") return undefined;
  const tpl = synthesize(R, r, 0, new Set()) as Record<string, Json>;
  const props = R.properties(r);
  const sing = singularize(resource);
  const objKey = [sing, resource, "data", "object", "payload", "resource"].find((k) => props[k]) ?? Object.keys(props).find((k) => idLike(R, R.resolve(props[k])));
  if (objKey) {
    const inner = R.resolve(props[objKey]);
    const innerProps = R.properties(inner);
    if (objKey === "data" && innerProps.object && !idLike(R, inner)) (tpl.data as Record<string, Json>).object = "{{$object}}";
    else tpl[objKey] = "{{$object}}";
  }
  for (const k of Object.keys(tpl)) {
    if (/^(type|event|event_type|eventtype|topic)$/i.test(k)) tpl[k] = "{{$type}}";
    if (k === "id" && objKey !== "id") tpl[k] = "{{$eventId}}";
    if (/^(created|created_at|timestamp|occurred_at)$/i.test(k)) tpl[k] = typeOf(R.resolve(props[k])) === "integer" ? "{{$created}}" : "{{$createdIso}}";
  }
  return tpl;
}
