import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IdDef, Json } from "./types.js";

const BLOCKED = new Set(["__proto__", "prototype", "constructor"]);

/** Parse `a[b][0][c]=1&expand[]=x` into nested objects/arrays, ignoring prototype keys. */
export function parseForm(body: string): Record<string, Json> {
  const out: Record<string, Json> = Object.create(null);
  const params = new URLSearchParams(body);
  for (const [rawKey, value] of params) {
    const m = rawKey.match(/^([^[\]]+)((?:\[[^[\]]*\])*)$/);
    if (!m) continue;
    const keys = [m[1]!, ...[...(m[2] ?? "").matchAll(/\[([^[\]]*)\]/g)].map((x) => x[1]!)];
    if (keys.some((k) => BLOCKED.has(k)) || keys.length > 8) continue;
    let cur: Record<string, Json> | Json[] = out;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const last = i === keys.length - 1;
      const nextKey = keys[i + 1];
      const nextIsArray = nextKey === "" || (nextKey !== undefined && /^\d+$/.test(nextKey));
      if (Array.isArray(cur)) {
        const idx = k === "" ? cur.length : Number(k);
        if (!Number.isInteger(idx) || idx > 1000) break;
        if (last) { cur[idx] = value; break; }
        cur[idx] ??= nextIsArray ? [] : (Object.create(null) as Record<string, Json>);
        cur = cur[idx] as Record<string, Json> | Json[];
      } else {
        if (last) { cur[k] = value; break; }
        if (cur[k] === undefined || typeof cur[k] !== "object" || cur[k] === null) cur[k] = nextIsArray ? [] : (Object.create(null) as Record<string, Json>);
        cur = cur[k] as Record<string, Json> | Json[];
      }
    }
  }
  return plain(out) as Record<string, Json>;
}

/** Convert null-prototype objects to plain ones (for JSON output and equality). */
export function plain(v: Json): Json {
  if (Array.isArray(v)) return v.filter((x) => x !== undefined).map(plain);
  if (v && typeof v === "object") {
    const o: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) if (!BLOCKED.has(k)) o[k] = plain(x);
    return o;
  }
  return v;
}

/** JSON.parse that drops prototype keys. */
export function safeJsonParse(text: string): Json {
  return JSON.parse(text, (k, v) => (BLOCKED.has(k) ? undefined : v)) as Json;
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function randomAlnum(n: number): string {
  const bytes = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALNUM[bytes[i]! % ALNUM.length];
  return s;
}
export function randomHex(n: number): string {
  return randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}

export class IdFactory {
  private counters = new Map<string, number>();
  next(def: IdDef | undefined, scopeKey = ""): string | number {
    const d = def ?? { style: "uuid" };
    switch (d.style) {
      case "prefixed": return `${d.prefix ?? ""}${randomAlnum(d.length ?? 14)}`;
      case "hex": return `${d.prefix ?? ""}${randomHex(d.length ?? 32)}`;
      case "int": {
        const key = `int:${d.prefix ?? ""}`;
        const n = (this.counters.get(key) ?? 1_000_000) + 1 + Math.floor(Math.random() * 7);
        this.counters.set(key, n);
        return n;
      }
      case "sequence": {
        const key = `seq:${d.prefix ?? ""}:${scopeKey}`;
        const n = (this.counters.get(key) ?? 0) + 1;
        this.counters.set(key, n);
        return n;
      }
      default: return `${d.prefix ?? ""}${randomUUID()}`;
    }
  }
  reset(): void { this.counters.clear(); }
}

// ---- type coercion for form-encoded bodies ----
export function coerce(value: Json, type: string | undefined): Json {
  if (type === undefined || value === null) return value;
  if (typeof value === "string") {
    if (type === "integer" && /^-?\d+$/.test(value)) return Number(value);
    if (type === "number" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (type === "boolean") return value === "true" || value === "1";
    if (type === "array") return value === "" ? [] : [value];
  }
  if (type === "array" && value && typeof value === "object" && !Array.isArray(value)) return Object.values(value);
  return value;
}

// ---- secrets and card data ----
const SECRET_HEADER = /^(authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|proxy-authorization)$/i;
export function maskSecret(s: string): string {
  if (s.length <= 8) return "••••";
  const m = s.match(/^((?:Bearer|Basic|token)\s+)?(.*)$/i);
  const lead = m?.[1] ?? "";
  const rest = m?.[2] ?? s;
  const prefix = rest.match(/^([a-z]{2,8}_(?:test_|live_)?)/i)?.[1] ?? "";
  if (rest.length - prefix.length < 12) return `${lead}${prefix}••••`;
  return `${lead}${prefix}…${rest.slice(-4)}`;
}
export function maskHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADER.test(k) ? maskSecret(v) : v;
  return out;
}

export function luhn(num: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Well-known test card numbers published by major providers. */
export const COMMON_TEST_CARDS = new Set([
  "4242424242424242", "4000056655665556", "5555555555554444", "2223003122003222", "5200828282828210",
  "5105105105105100", "378282246310005", "371449635398431", "6011111111111117", "3056930009020004",
  "36227206271667", "6555900000604105", "3566002020360505", "6200000000000005", "4111111111111111",
  "4000000000000002", "4000000000009995", "4000000000003220", "4000002500003155", "4000000000000069",
  "4000000000000127", "4000000000000119", "4084084084084081", "5060666666666666666", "4084080000000409",
]);

const CARD_KEY = /(card|^pan$|_pan$|ccnum|cc_number|card_?number|^number$)/i;

/** Find a real-looking card number (Luhn-valid, not a documented test number) in a request body. */
export function findRealCard(body: Json, extraTest: string[] = [], keyPath: string[] = []): string | null {
  if (typeof body === "string" || typeof body === "number") {
    const s = String(body).replace(/[\s-]/g, "");
    const inCardField = keyPath.some((k) => CARD_KEY.test(k));
    if (inCardField && /^\d{13,19}$/.test(s) && luhn(s) && !COMMON_TEST_CARDS.has(s) && !extraTest.includes(s)) return s;
    return null;
  }
  if (Array.isArray(body)) {
    for (const x of body) { const f = findRealCard(x, extraTest, keyPath); if (f) return f; }
    return null;
  }
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body)) { const f = findRealCard(v, extraTest, [...keyPath, k]); if (f) return f; }
  }
  return null;
}

/** Mask card numbers anywhere in a value (for logs and the dashboard). */
export function maskCards(v: Json): Json {
  if (typeof v === "string") return v.replace(/\b(\d[ -]?){9,15}(\d{4})\b/g, (m, _a, last: string) => (luhn(m.replace(/\D/g, "")) ? `••••${last}` : m));
  if (Array.isArray(v)) return v.map(maskCards);
  if (v && typeof v === "object") {
    const o: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) o[k] = /^(cvc|cvv|cvv2|csc|pin|otp)$/i.test(k) && x !== null ? "•••" : maskCards(x);
    return o;
  }
  return v;
}

// ---- webhook signatures (what providers document; the user's verification code runs unchanged) ----
export function signStripe(secret: string, payload: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}
export function signHmacHex(alg: "sha256" | "sha512", secret: string, payload: string): string {
  return createHmac(alg, secret).update(payload).digest("hex");
}
/** Twilio: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)) for form posts. */
export function signTwilio(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}
/** Svix (used by Resend): `v1,` + base64(HMAC-SHA256(base64decode(secret without whsec_), id.ts.body)). */
export function signSvix(secret: string, id: string, ts: number, payload: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${payload}`).digest("base64")}`;
}

// ---- seeded PRNG for chaos (mulberry32) ----
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isLoopbackUrl(raw: string, extraHosts: string[] = []): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost") || extraHosts.map((x) => x.toLowerCase()).includes(h);
  } catch {
    return false;
  }
}

export function singularize(name: string): string {
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  if (/(ss|sh|ch|x)es$/.test(name)) return name.slice(0, -2);
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}
