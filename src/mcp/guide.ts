// What an agent needs to write a twin definition from documentation. Kept short and concrete.
export const DEFINITION_GUIDE = `# Writing a Mock Anything twin definition

A twin definition is JSON (or YAML) data. One engine runs it; nothing in it is executed.
Write only facts from the docs: paths, field names, ID formats, status values, error shapes, test values.
Never copy documentation prose. Keep it to the flows the user needs.

Required top level: schema: 1, id (lowercase), title, auth, resources, operations.

auth: { type: "bearer" | "basic" | "header" | "query" | "none", name?: header/query name, livePattern?: regex for live keys (refused) }

conventions (optional):
  timestamps: "unix" | "iso"
  single: envelope for one object, e.g. { status: true, message: "OK", data: "{{$data}}" }
  list: envelope for lists, e.g. { object: "list", data: "{{$items}}", has_more: "{{$hasMore}}" }   (placeholders: $items $hasMore $total $page $limit $pageCount $url)
  listStyle: { kind: "cursor" | "page", limitParam, afterParam, pageParam, pageBase: 0|1 }
  error: error body with $message $code $type $param $status, e.g. { error: { message: "{{$message}}", code: "{{$code}}" } }
  errors: { notFound | unauthorized | missingParam | invalidState | rateLimited: { status, message, code?, type? } }
  bodyMap: { RequestField: stored_field }      createStatus: 200 | 201      deleteStatus: 200 | 204

resources: { <name>: {
  singular?, id: { style: "prefixed" | "uuid" | "int" | "hex", prefix?: "cus_", length?: 14, field?: "sid" },
  required?: [fields], types?: { amount: "integer" }, readonly?: [fields], hidden?: [fields],
  defaults?: { field: value or template },        templates: "{{now}}", "{{nowIso}}", "{{body.x ?? 'default'}}", "{{newId('ch_')}}", "{{uuid()}}", "{{checkoutUrl()}}", "{{seq()}}"
  refs?: { customer: "customers" }, filters?: { query_param: field }, scope?: [path params],
  lifecycle?: { field: "status", initial: "pending", transitions: { pay: { from: ["pending"], to: "paid", set?: {...}, emit?: ["charge.success"] } },
                auto?: [{ afterMs: 500, transition: "deliver" }] }
} }

operations: [ { method, path (after basePath), action: "create" | "read" | "update" | "delete" | "list" | "transition" | "static",
  resource, transition? (for action transition), lookup?: { fields: ["reference"], from: "{{params.reference}}" },
  then?: [{ transition, when }], emit?: [event types], response?: { status?, body? } } ]

webhooks (optional): { signing: { scheme: "stripe" | "hmac-sha256-hex" | "hmac-sha512-hex" | "svix" | "hmac-sha1-base64-url" | "none", header?, prefix?, secretFrom?: "generated" | "requestKey" },
  envelope?: { event: "{{$type}}", data: "{{$object}}" } }

scenarios (optional): { card_declined: { description, on: "<resource>.<transition>" | "<resource>.create", when?: { path: "obj.payment_method", in: [...] },
  to?, set?, emit?, error?: { status: 402, message, code } } }

checkout (optional, for redirect flows): [{ resource, succeed: <transition>, fail?: <transition>, returnUrlField?, amountField?, currencyField?, amountMinorUnits? }]

Conditions: { path, equals | in | exists | truthy | matches | lte | gte } or { all: [...] } / { any: [...] } / { not: ... }.

Minimal example:
{
  "schema": 1, "id": "acme-pay", "title": "Acme Pay", "basePath": "/v1",
  "auth": { "type": "bearer" },
  "conventions": { "timestamps": "iso", "single": { "ok": true, "data": "{{$data}}" }, "list": { "ok": true, "data": "{{$items}}" },
                   "error": { "ok": false, "error": "{{$message}}" }, "createStatus": 201 },
  "resources": { "payments": { "singular": "payment", "id": { "style": "prefixed", "prefix": "pay_", "length": 16 },
      "required": ["amount", "currency"], "types": { "amount": "integer" },
      "defaults": { "created_at": "{{nowIso}}" },
      "lifecycle": { "field": "status", "initial": "pending",
        "transitions": { "capture": { "from": ["pending"], "to": "captured", "emit": ["payment.captured"] },
                         "refund": { "from": ["captured"], "to": "refunded", "emit": ["payment.refunded"] } } } } },
  "operations": [
    { "method": "POST", "path": "/payments", "action": "create", "resource": "payments", "emit": ["payment.created"] },
    { "method": "GET", "path": "/payments", "action": "list", "resource": "payments" },
    { "method": "GET", "path": "/payments/{id}", "action": "read", "resource": "payments" },
    { "method": "POST", "path": "/payments/{id}/capture", "action": "transition", "resource": "payments", "transition": "capture" },
    { "method": "POST", "path": "/payments/{id}/refund", "action": "transition", "resource": "payments", "transition": "refund" } ],
  "webhooks": { "signing": { "scheme": "hmac-sha256-hex", "header": "x-acme-signature" }, "envelope": { "event": "{{$type}}", "data": "{{$object}}" } }
}

Then start it. With the MCP server: twin_start with { "definition": <your JSON> }.
From a shell: save it as twin.json, check it with \`npx @shipatmidnight/mockanything validate twin.json\`, then run \`npx @shipatmidnight/mockanything twin.json\`.
If it is rejected, the error lists what to fix.`;
