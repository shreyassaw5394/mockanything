/**
 * A twin definition is plain data. One engine runs every twin; nothing in a definition is executed.
 *
 * Template strings: a string containing `{{ expr }}` is evaluated against the request context.
 * If the whole string is one template, the raw value is kept (numbers stay numbers, objects stay objects).
 * Expressions are paths (`body.amount`, `obj.status`, `params.id`, `query.limit`, `now`), quoted strings,
 * numbers, `a ?? b` fallbacks, and a few functions: `newId('ch')`, `hex(8)`, `uuid()`, `checkoutUrl()`.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Template = Json;

export interface TwinDefinition {
  schema: 1;
  id: string;
  title: string;
  description?: string;
  /** Where the facts in this twin came from. Shown in `mockanything list` and the dashboard. */
  source?: { kind: "pack" | "openapi" | "agent" | "har"; url?: string; license?: string; notes?: string };
  /** True when the twin was produced by inference rather than hand-tuned. */
  inferred?: boolean;
  basePath?: string;
  auth: AuthDef;
  conventions?: Conventions;
  resources: Record<string, ResourceDef>;
  operations: OperationDef[];
  webhooks?: WebhookDef;
  /** Named behaviours: magic values or forced from MCP/dashboard. */
  scenarios?: Record<string, ScenarioDef>;
  /** Test card numbers this provider documents; real-looking card numbers outside this list are refused. */
  testCards?: string[];
  /** Hosted test page (neutral, loopback only) for redirect flows such as checkout or 3-D Secure. */
  checkout?: CheckoutDef[];
  rateLimit?: { limit: number; windowMs: number };
  /** `rest`: requests the definition doesn't cover are served by a generic stateful REST store (marked in responses). */
  fallback?: "rest" | "none";
  /** Snippets printed by `mockanything env`. `{{baseUrl}}` and `{{secret}}` are filled in. */
  snippets?: Record<string, string>;
  /** Short notes for users and agents (supported flows, magic values). */
  notes?: string[];
}

export interface AuthDef {
  type: "bearer" | "basic" | "header" | "query" | "none";
  /** Header or query parameter name for `header` / `query`. */
  name?: string;
  /** Regex (source) for keys that are clearly live/production. Requests using them are refused. */
  livePattern?: string;
  /** Regex (source) for keys that might be real but can't be told apart from test ones: warn only. */
  warnPattern?: string;
  /** Optional: auth is not enforced (any or no key works). Default false: a key of some kind is required. */
  optional?: boolean;
}

export interface Conventions {
  /** Field holding the object's id. Default `id`. */
  idField?: string;
  timestamps?: "unix" | "iso" | "rfc2822";
  /** Envelope for single-object responses. `{{$data}}` is the object. Default: the object itself. */
  single?: Template;
  /** Envelope for list responses. Placeholders: $items $hasMore $total $page $limit $pageCount $url. */
  list?: Template;
  listStyle?: ListStyle;
  /** Error body. Placeholders: $status $message $code $type $param plus any `extra` keys. */
  error?: Template;
  /** Leave fields that came out null out of error bodies (Stripe and Paystack omit them). */
  errorDropNulls?: boolean;
  /** Errors used by the engine itself. */
  errors?: {
    notFound?: ErrorSpec;
    unauthorized?: ErrorSpec;
    liveKey?: ErrorSpec;
    missingParam?: ErrorSpec;
    invalidState?: ErrorSpec;
    rateLimited?: ErrorSpec;
    serverError?: ErrorSpec;
    realCard?: ErrorSpec;
  };
  idempotencyHeader?: string;
  /** Map incoming body keys to stored field names (e.g. Twilio `To` → `to`). */
  bodyMap?: Record<string, string>;
  /** Keys that control the request and are never stored (e.g. Stripe `expand`, `confirm`). */
  ignore?: string[];
  /** Status code for successful creates. Default 200. */
  createStatus?: number;
  /** Status code for deletes. Default 200 (with body) — 204 sends no body. */
  deleteStatus?: number;
  deleteBody?: Template;
  /** Stripe-style `expand[]` support for fields that hold ids of other resources. */
  expandParam?: string;
}

export interface ListStyle {
  kind: "cursor" | "page";
  limitParam?: string;
  defaultLimit?: number;
  maxLimit?: number;
  /** cursor style: return items after this id. */
  afterParam?: string;
  beforeParam?: string;
  /** page style */
  pageParam?: string;
  pageBase?: 0 | 1;
  order?: "desc" | "asc";
  /** Add a GitHub-style `Link` header. */
  linkHeader?: boolean;
}

export interface ErrorSpec {
  status: number;
  message: string;
  code?: string;
  type?: string;
  param?: string;
  extra?: Record<string, Template>;
}

export interface ResourceDef {
  /** Singular name used in messages and webhook names, e.g. `customer`. */
  singular?: string;
  id?: IdDef;
  /** Field values on create. Templates are evaluated; body values override unless the field is `readonly`. */
  defaults?: Record<string, Template>;
  /** Fields the client may set. `*` (default) accepts any body field. */
  accept?: string[] | "*";
  readonly?: string[];
  /** Body fields that must be present on create. */
  required?: string[];
  /** Coerce form-encoded strings: `integer`, `number`, `boolean`, `array`, `object`. */
  types?: Record<string, "integer" | "number" | "boolean" | "string" | "array" | "object">;
  /** Fields holding ids of other resources, for `expand` and existence checks. */
  refs?: Record<string, string>;
  /** Fields set on every update, e.g. `updated_at`. */
  onUpdate?: Record<string, Template>;
  lifecycle?: Lifecycle;
  /** Path params that scope this resource (e.g. GitHub `owner`, `repo`). Lists are filtered by them. */
  scope?: string[];
  /** Query param → field filters for lists. */
  filters?: Record<string, string | { field: string; default?: string; all?: string }>;
  /** Hidden from responses (internal bookkeeping). */
  hidden?: string[];
  /** Read-only in the real API (no create call): reads and lists return made-up sample objects shaped by `defaults`. */
  sample?: boolean;
  /** Fields that must be unique across objects (checked on create). */
  unique?: { field: string; error: ErrorSpec }[];
}

export interface IdDef {
  style: "prefixed" | "uuid" | "int" | "hex" | "sequence";
  prefix?: string;
  length?: number;
  /** `sequence` counts per scope (GitHub issue numbers). */
  field?: string;
}

export interface Lifecycle {
  field: string;
  initial: Template;
  /** First matching entry overrides `initial` (e.g. a PaymentIntent created with a payment method). */
  initialWhen?: { when: Condition; value: Template }[];
  transitions: Record<string, TransitionDef>;
  /** Automatic transitions after create, e.g. Twilio queued → sent → delivered. */
  auto?: { afterMs: number; transition: string; when?: Condition }[];
}

export interface TransitionDef {
  from?: string[];
  to?: Template;
  set?: Record<string, Template>;
  inc?: Record<string, Template>;
  /** Conditions that must hold, else the error is returned and nothing changes. */
  require?: { when: Condition; error: ErrorSpec }[];
  emit?: EmitDef[];
  /** First matching case replaces to/set/inc/emit. */
  cases?: TransitionCase[];
  /** Name of a scenario group; scenarios with `on` equal to this name are checked first. */
  scenarios?: string;
}

export interface TransitionCase {
  when: Condition;
  to?: Template;
  set?: Record<string, Template>;
  inc?: Record<string, Template>;
  emit?: EmitDef[];
}

export type Condition =
  | { path: string; equals?: Json; in?: Json[]; exists?: boolean; truthy?: boolean; matches?: string; lte?: string; gte?: string }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface ScenarioDef {
  description: string;
  /** Where it applies: `<resource>.create`, `<resource>.<transition>`, or a transition's `scenarios` group. */
  on: string;
  /** Magic-value trigger. Without it, the scenario only runs when forced. */
  when?: Condition;
  to?: Template;
  set?: Record<string, Template>;
  emit?: EmitDef[];
  /** Respond with this error (after applying to/set/emit, as providers do for declines). */
  error?: ErrorSpec;
  /** Delay the response. */
  delayMs?: number;
}

export type EmitDef =
  | string
  | {
      type: string;
      /** Deliver to a URL taken from the object (e.g. Twilio `status_callback`) instead of registered endpoints. */
      to?: string;
      /** Payload template overriding the webhook envelope. */
      payload?: Template;
      format?: "json" | "form";
      headers?: Record<string, Template>;
    };

export interface WebhookDef {
  signing: SigningDef;
  /** Envelope for events. Placeholders: $eventId $type $object $created $action. */
  envelope?: Template;
  eventId?: IdDef;
  /** Store events as a resource so they can be listed (Stripe `/v1/events`). */
  storeAs?: string;
  headers?: Record<string, Template>;
  /** Operation-free registration: resource whose creates register endpoints (Stripe webhook_endpoints). */
  registration?: { resource: string; urlField: string; eventsField?: string; secretField?: string };
  /** Retries on failure (non-2xx or network error). */
  retries?: number;
}

export interface SigningDef {
  scheme: "stripe" | "hmac-sha256-hex" | "hmac-sha512-hex" | "hmac-sha1-base64-url" | "svix" | "none";
  header?: string;
  prefix?: string;
  /** `generated` (default): a secret printed at start. `requestKey`: the API key/password used by the request. */
  secretFrom?: "generated" | "requestKey";
  secretPrefix?: string;
}

export interface CheckoutDef {
  /** Transitions run by the neutral test page's buttons. */
  resource: string;
  succeed: string;
  fail?: string;
  /** Field with the return URL (loopback only). */
  returnUrlField?: string;
  title?: string;
  amountField?: string;
  currencyField?: string;
  /** Amounts are in minor units (cents): show 2000 as 20.00. */
  amountMinorUnits?: boolean;
  /** Query parameters added to the return URL, e.g. `{ reference: "{{obj.reference}}" }`. */
  returnQuery?: Record<string, Template>;
}

export type OperationAction = "create" | "read" | "update" | "delete" | "list" | "transition" | "static";

export interface OperationDef {
  method: string;
  path: string;
  action: OperationAction;
  resource?: string;
  transition?: string;
  /** Look the object up by a field other than the id. `from` is a template like `{{params.reference}}`. */
  lookup?: { fields: string[]; from: string };
  /** Path param holding the id (default: the last `{param}`). */
  idParam?: string;
  /** Transitions to run right after create when their condition holds (Stripe `confirm=true`). */
  then?: { transition: string; when?: Condition }[];
  /** Override response for this operation. `{{$data}}` is the object; `{{$items}}` for lists. */
  response?: { status?: number; body?: Template; headers?: Record<string, Template> };
  /** Extra emits on success. */
  emit?: EmitDef[];
  /** Effects on other objects, e.g. a comment increments its issue's `comments` count. */
  effects?: EffectDef[];
  /** Body checks before anything changes. */
  require?: { when: Condition; error: ErrorSpec }[];
  /** Set on the created object from path params etc. */
  set?: Record<string, Template>;
  /** For `static`: a canned body. */
  summary?: string;
}

export interface EffectDef {
  resource: string;
  /** Template resolving to the target id or a lookup value. */
  id: string;
  lookup?: string[];
  set?: Record<string, Template>;
  inc?: Record<string, Template>;
  /** Fail the request if the target is missing. */
  mustExist?: ErrorSpec;
  /** Checks against the target (`target.*`) before anything changes. */
  require?: { when: Condition; error: ErrorSpec }[];
  emit?: EmitDef[];
}
