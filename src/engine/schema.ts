import { z } from "zod";
import type { TwinDefinition } from "./types.js";

// Definitions can come from agents or strangers, so the schema is strict and bounded.
const str = (max = 2000) => z.string().max(max);
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.number(), str(20_000), z.array(json).max(1000), z.record(str(200), json)]));
const condition: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(condition).max(50) }).strict(),
    z.object({ any: z.array(condition).max(50) }).strict(),
    z.object({ not: condition }).strict(),
    z.object({
      path: str(300), equals: json.optional(), in: z.array(json).max(200).optional(), exists: z.boolean().optional(),
      truthy: z.boolean().optional(), matches: str(200).optional(), lte: str(300).optional(), gte: str(300).optional(),
    }).strict(),
  ]),
);
const errorSpec = z.object({
  status: z.number().int().min(100).max(599), message: str(1000), code: str(200).optional(), type: str(200).optional(),
  param: str(200).optional(), extra: z.record(str(100), json).optional(),
}).strict();
const requireList = z.array(z.object({ when: condition, error: errorSpec }).strict()).max(50);
const emit = z.union([
  str(200),
  z.object({
    type: str(200), to: str(500).optional(), payload: json.optional(), format: z.enum(["json", "form"]).optional(),
    headers: z.record(str(100), json).optional(),
  }).strict(),
]);
const tmplMap = z.record(str(200), json);
const idDef = z.object({
  style: z.enum(["prefixed", "uuid", "int", "hex", "sequence"]), prefix: str(40).optional(),
  length: z.number().int().min(1).max(128).optional(), field: str(100).optional(),
}).strict();
const change = { to: json.optional(), set: tmplMap.optional(), inc: tmplMap.optional(), emit: z.array(emit).max(50).optional() };
const transition = z.object({
  from: z.array(str(100)).max(50).optional(), require: requireList.optional(),
  cases: z.array(z.object({ when: condition, ...change }).strict()).max(50).optional(), scenarios: str(100).optional(), ...change,
}).strict();
const resource = z.object({
  singular: str(300).optional(), id: idDef.optional(), defaults: tmplMap.optional(),
  accept: z.union([z.literal("*"), z.array(str(200)).max(500)]).optional(), readonly: z.array(str(200)).max(500).optional(),
  required: z.array(str(200)).max(200).optional(),
  types: z.record(str(200), z.enum(["integer", "number", "boolean", "string", "array", "object"])).optional(),
  refs: z.record(str(200), str(200)).optional(), onUpdate: tmplMap.optional(),
  lifecycle: z.object({
    field: str(100), initial: json, initialWhen: z.array(z.object({ when: condition, value: json }).strict()).max(20).optional(),
    transitions: z.record(str(100), transition),
    auto: z.array(z.object({ afterMs: z.number().min(0).max(3_600_000), transition: str(100), when: condition.optional() }).strict()).max(20).optional(),
  }).strict().optional(),
  scope: z.array(str(100)).max(200).optional(), sample: z.boolean().optional(),
  filters: z.record(str(100), z.union([str(200), z.object({ field: str(200), default: str(200).optional(), all: str(200).optional() }).strict()])).optional(),
  hidden: z.array(str(200)).max(200).optional(),
  unique: z.array(z.object({ field: str(200), error: errorSpec }).strict()).max(20).optional(),
}).strict();
const effect = z.object({
  resource: str(200), id: str(500), lookup: z.array(str(200)).max(10).optional(), set: tmplMap.optional(), inc: tmplMap.optional(),
  mustExist: errorSpec.optional(), require: requireList.optional(), emit: z.array(emit).max(50).optional(),
}).strict();
const operation = z.object({
  method: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE|HEAD|get|post|put|patch|delete|head)$/), path: z.string().max(500).regex(/^\//),
  action: z.enum(["create", "read", "update", "delete", "list", "transition", "static"]), resource: str(200).optional(),
  transition: str(100).optional(), lookup: z.object({ fields: z.array(str(200)).min(1).max(10), from: str(300) }).strict().optional(),
  idParam: str(100).optional(), then: z.array(z.object({ transition: str(100), when: condition.optional() }).strict()).max(10).optional(),
  response: z.object({ status: z.number().int().min(100).max(599).optional(), body: json.optional(), headers: z.record(str(100), json).optional() }).strict().optional(),
  emit: z.array(emit).max(50).optional(), effects: z.array(effect).max(10).optional(), require: requireList.optional(),
  set: tmplMap.optional(), summary: str(500).optional(),
  stream: z.object({
    when: condition, events: z.array(json).min(1).max(200), eventField: str(100).optional(), done: str(100).optional(),
    cases: z.array(z.object({ when: condition, events: z.array(json).min(1).max(200) }).strict()).max(20).optional(),
  }).strict().optional(),
}).strict();
const errors = z.object({
  notFound: errorSpec.optional(), unauthorized: errorSpec.optional(), liveKey: errorSpec.optional(), missingParam: errorSpec.optional(),
  invalidState: errorSpec.optional(), rateLimited: errorSpec.optional(), serverError: errorSpec.optional(), realCard: errorSpec.optional(),
}).strict();

export const twinSchema = z.object({
  schema: z.literal(1),
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/),
  title: str(120),
  description: str(2000).optional(),
  source: z.object({ kind: z.enum(["pack", "openapi", "agent", "har"]), url: str(1000).optional(), license: str(200).optional(), notes: str(2000).optional() }).strict().optional(),
  inferred: z.boolean().optional(),
  basePath: z.string().max(200).regex(/^(\/.*)?$/).optional(),
  auth: z.object({
    type: z.enum(["bearer", "basic", "header", "query", "none"]), name: str(100).optional(), livePattern: str(200).optional(),
    warnPattern: str(200).optional(), optional: z.boolean().optional(),
  }).strict(),
  conventions: z.object({
    idField: str(100).optional(), timestamps: z.enum(["unix", "iso", "rfc2822"]).optional(), single: json.optional(), list: json.optional(),
    listStyle: z.object({
      kind: z.enum(["cursor", "page"]), limitParam: str(100).optional(), defaultLimit: z.number().int().min(1).max(1000).optional(),
      maxLimit: z.number().int().min(1).max(10_000).optional(), afterParam: str(100).optional(), beforeParam: str(100).optional(),
      pageParam: str(100).optional(), pageBase: z.union([z.literal(0), z.literal(1)]).optional(), order: z.enum(["desc", "asc"]).optional(),
      linkHeader: z.boolean().optional(),
    }).strict().optional(),
    error: json.optional(), errors: errors.optional(), idempotencyHeader: str(100).optional(), bodyMap: z.record(str(200), str(200)).optional(),
    ignore: z.array(str(200)).max(200).optional(), createStatus: z.number().int().min(100).max(599).optional(),
    deleteStatus: z.number().int().min(100).max(599).optional(), deleteBody: json.optional(), expandParam: str(100).optional(), errorDropNulls: z.boolean().optional(),
  }).strict().optional(),
  resources: z.record(z.string().max(200), resource).refine((r) => Object.keys(r).length <= 2000, "too many resources"),
  operations: z.array(operation).max(10_000),
  webhooks: z.object({
    signing: z.object({
      scheme: z.enum(["stripe", "hmac-sha256-hex", "hmac-sha512-hex", "hmac-sha1-base64-url", "svix", "none"]), header: str(100).optional(),
      prefix: str(50).optional(), secretFrom: z.enum(["generated", "requestKey"]).optional(), secretPrefix: str(50).optional(),
    }).strict(),
    envelope: json.optional(), eventId: idDef.optional(), storeAs: str(200).optional(), headers: z.record(str(100), json).optional(),
    registration: z.object({ resource: str(200), urlField: str(200), eventsField: str(200).optional(), secretField: str(200).optional() }).strict().optional(),
    retries: z.number().int().min(0).max(10).optional(),
  }).strict().optional(),
  scenarios: z.record(str(100), z.object({
    description: str(1000), on: str(200), when: condition.optional(), to: json.optional(), set: tmplMap.optional(),
    emit: z.array(emit).max(50).optional(), error: errorSpec.optional(), delayMs: z.number().min(0).max(120_000).optional(),
  }).strict()).optional(),
  testCards: z.array(z.string().regex(/^\d{12,19}$/)).max(200).optional(),
  checkout: z.array(z.object({
    resource: str(200), succeed: str(100), fail: str(100).optional(), returnUrlField: str(200).optional(), title: str(200).optional(),
    amountField: str(200).optional(), currencyField: str(200).optional(), amountMinorUnits: z.boolean().optional(),
    returnQuery: z.record(str(100), json).optional(),
  }).strict()).max(20).optional(),
  rateLimit: z.object({ limit: z.number().int().min(1).max(1_000_000), windowMs: z.number().int().min(10).max(3_600_000) }).strict().optional(),
  fallback: z.enum(["rest", "none"]).optional(),
  snippets: z.record(str(50), str(5000)).optional(),
  notes: z.array(str(1000)).max(50).optional(),
}).strict();

export class DefinitionError extends Error {}

/** Validate a definition and check internal references. Throws DefinitionError with readable messages. */
export function validateDefinition(input: unknown): TwinDefinition {
  const parsed = twinSchema.safeParse(input);
  if (!parsed.success) {
    const msgs = parsed.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new DefinitionError(`Invalid twin definition:\n  ${msgs.join("\n  ")}`);
  }
  const def = parsed.data as unknown as TwinDefinition;
  const problems: string[] = [];
  for (const [i, op] of def.operations.entries()) {
    if (op.action !== "static" && (!op.resource || !def.resources[op.resource])) problems.push(`operations[${i}] (${op.method} ${op.path}): unknown resource "${op.resource ?? ""}"`);
    if (op.action === "transition") {
      const lc = op.resource ? def.resources[op.resource]?.lifecycle : undefined;
      if (!op.transition || !lc?.transitions[op.transition]) problems.push(`operations[${i}] (${op.method} ${op.path}): unknown transition "${op.transition ?? ""}"`);
    }
    for (const t of op.then ?? []) {
      const lc = op.resource ? def.resources[op.resource]?.lifecycle : undefined;
      if (!lc?.transitions[t.transition]) problems.push(`operations[${i}]: then → unknown transition "${t.transition}"`);
    }
    for (const e of op.effects ?? []) if (!def.resources[e.resource]) problems.push(`operations[${i}]: effect on unknown resource "${e.resource}"`);
  }
  for (const [name, r] of Object.entries(def.resources)) {
    for (const [f, target] of Object.entries(r.refs ?? {})) if (!def.resources[target]) problems.push(`resources.${name}.refs.${f}: unknown resource "${target}"`);
    for (const a of r.lifecycle?.auto ?? []) if (!r.lifecycle?.transitions[a.transition]) problems.push(`resources.${name}.lifecycle.auto: unknown transition "${a.transition}"`);
  }
  for (const c of def.checkout ?? []) {
    const lc = def.resources[c.resource]?.lifecycle;
    if (!lc) problems.push(`checkout: resource "${c.resource}" has no lifecycle`);
    else for (const t of [c.succeed, c.fail].filter(Boolean) as string[]) if (!lc.transitions[t]) problems.push(`checkout: unknown transition "${t}" on ${c.resource}`);
  }
  if (def.webhooks?.storeAs && !def.resources[def.webhooks.storeAs]) problems.push(`webhooks.storeAs: unknown resource "${def.webhooks.storeAs}"`);
  if (def.webhooks?.registration && !def.resources[def.webhooks.registration.resource]) problems.push(`webhooks.registration: unknown resource`);
  for (const p of [def.auth.livePattern, def.auth.warnPattern].filter(Boolean) as string[]) {
    try { new RegExp(p); } catch { problems.push(`auth pattern is not a valid regex: ${p}`); }
  }
  if (problems.length) throw new DefinitionError(`Invalid twin definition:\n  ${problems.slice(0, 20).join("\n  ")}`);
  return def;
}
