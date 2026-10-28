/**
 * Outbound fetch for URLs we don't control (user-supplied pages, search results, enterprise endpoints).
 *
 * - Every connection's resolved address is checked at connect time (DNS is pinned to the checked answer),
 *   so a hostname that resolves to a private, loopback, link-local or metadata address is refused.
 * - Redirects are followed manually and every hop is validated before it is requested.
 * - Response bodies are capped, and every request has a timeout.
 */
import { Agent, fetch as undiciFetch, type RequestInit as UndiciInit, type Response as UndiciResponse } from "undici";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";

export class BlockedUrlError extends Error {
  /** Client error: the URL itself is not acceptable. */
  readonly statusCode = 400;
  constructor(message: string) { super(message); this.name = "BlockedUrlError"; }
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** True for any address that is not a normal public unicast address. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (kind === 6) {
    const a = ip.toLowerCase();
    if (a === "::" || a === "::1") return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? a.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // mapped v4 in hex form
    const first = parseInt(a.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (a.startsWith("64:ff9b:") || a.startsWith("2001:db8:") || a.startsWith("2002:")) return true; // NAT64, docs, 6to4
    return false;
  }
  return true; // not an IP at all: refuse
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/** Syntactic checks before any network activity. Hostnames are checked again at connect time. */
export function assertPublicUrl(raw: string | URL, opts: { httpsOnly?: boolean } = {}): URL {
  let u: URL;
  try { u = new URL(String(raw)); } catch { throw new BlockedUrlError("URL not allowed: invalid URL"); }
  if (u.protocol !== "https:" && (opts.httpsOnly || u.protocol !== "http:")) throw new BlockedUrlError("URL not allowed: only public http/https URLs are supported");
  if (u.username || u.password) throw new BlockedUrlError("URL not allowed: credentials in URL");
  if (!ALLOWED_PORTS.has(u.port)) throw new BlockedUrlError("URL not allowed: non-standard port");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") {
    throw new BlockedUrlError("URL not allowed: internal host");
  }
  if (isIP(host) && isPrivateAddress(host)) throw new BlockedUrlError("URL not allowed: private address");
  // numeric / octal / hex IPv4 spellings that resolvers may accept
  if (!isIP(host) && /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) throw new BlockedUrlError("URL not allowed: numeric host");
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;
/** DNS lookup that refuses private answers. Exported for tests. */
export function guardedLookup(hostname: string, options: { all?: boolean } | number | undefined, cb: LookupCb, resolver = dnsLookup): void {
  resolver(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as unknown as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || bad) return cb(Object.assign(new BlockedUrlError(`URL not allowed: ${hostname} resolves to a private address`), { code: "EBLOCKED" }));
    if (typeof options === "object" && options?.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

const dispatcher = new Agent({
  connect: { lookup: guardedLookup as never, timeout: 10_000 },
  headersTimeout: 15_000,
  bodyTimeout: 15_000,
});

export interface SafeFetchOptions {
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  httpsOnly?: boolean;
}

export interface SafeResponse {
  ok: boolean;
  status: number;
  url: string;
  headers: Headers | UndiciResponse["headers"];
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

async function readCapped(res: UndiciResponse, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > maxBytes) { await res.body.cancel(); throw new BlockedUrlError(`Response too large (${declared} bytes)`); }
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new BlockedUrlError(`Response too large (over ${maxBytes} bytes)`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** fetch() for untrusted URLs. Same call shape as fetch for the parts we use. */
export async function safeFetch(url: string | URL, init: UndiciInit & { signal?: AbortSignal } = {}, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const { maxRedirects = 5, maxBytes = 5 * 1024 * 1024, timeoutMs = 15_000, httpsOnly = false } = opts;
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let current = assertPublicUrl(url, { httpsOnly });
  let method = (init.method || "GET").toUpperCase();
  let body = init.body;
  for (let hop = 0; ; hop++) {
    const res = await undiciFetch(current, { ...init, method, body, redirect: "manual", signal, dispatcher });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      if (hop >= maxRedirects) throw new BlockedUrlError("Too many redirects");
      current = assertPublicUrl(new URL(res.headers.get("location")!, current), { httpsOnly });
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
      continue;
    }
    let cached: Promise<string> | null = null;
    const text = () => (cached ??= method === "HEAD" ? Promise.resolve("") : readCapped(res, maxBytes));
    return { ok: res.ok, status: res.status, url: current.toString(), headers: res.headers, text, json: async <T>() => JSON.parse(await text()) as T };
  }
}
