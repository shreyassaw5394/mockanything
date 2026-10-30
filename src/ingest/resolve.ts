import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import { findPack, listPacks, parseDocument } from "../engine/load.js";
import { validateDefinition } from "../engine/schema.js";
import type { TwinDefinition } from "../engine/types.js";
import { isLoopbackUrl } from "../engine/util.js";
import { safeFetch } from "../lib/safeFetch.js";
import { ingestOpenApi, type InferenceReport } from "./openapi.js";
import { harToOpenApi, isHar } from "./har.js";

export interface Resolved {
  def: TwinDefinition;
  report?: InferenceReport;
  origin: "pack" | "definition" | "openapi-file" | "openapi-url" | "apis-guru" | "har";
  detail: string;
  alternatives?: string[];
}

export class DocsPageError extends Error {
  constructor(readonly url: string, readonly text: string) {
    super(`${url} looks like a documentation page, not an API description. Pass an OpenAPI/Swagger file or URL, or let your agent build the twin from these docs with the MCP tool \`twin_from_docs\`.`);
  }
}

export function homeDir(): string {
  const dir = process.env.MOCKANYTHING_HOME ?? join(homedir(), ".mockanything");
  mkdirSync(join(dir, "cache"), { recursive: true, mode: 0o700 });
  return dir;
}

const MAX_SPEC = 60 * 1024 * 1024;
const DIRECTORY = "https://api.apis.guru/v2/list.json";
const DAY = 24 * 60 * 60 * 1000;

/** Fetch text from a URL. Public URLs go through the guarded fetch; URLs on this machine are allowed directly. */
export async function fetchText(url: string, maxBytes = MAX_SPEC): Promise<{ text: string; contentType: string; finalUrl: string }> {
  const headers = { "user-agent": "mockanything (+https://mockanything.dev)", accept: "application/json, application/yaml, text/yaml, text/html;q=0.8, */*;q=0.5" };
  if (isLoopbackUrl(url)) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`${url} is larger than ${maxBytes} bytes`);
    return { text: buf.toString("utf8"), contentType: res.headers.get("content-type") ?? "", finalUrl: url };
  }
  const res = await safeFetch(url, { headers }, { maxBytes, timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return { text: await res.text(), contentType: String(res.headers.get("content-type") ?? ""), finalUrl: res.url };
}

function cachePath(key: string): string {
  return join(homeDir(), "cache", createHash("sha256").update(key).digest("hex").slice(0, 32));
}

async function cachedText(url: string, maxAgeMs: number): Promise<string> {
  const p = cachePath(url);
  if (existsSync(p) && Date.now() - statSync(p).mtimeMs < maxAgeMs) return readFileSync(p, "utf8");
  const { text } = await fetchText(url);
  writeFileSync(p, text, { mode: 0o600 });
  return text;
}

function isDefinition(doc: unknown): boolean {
  return !!doc && typeof doc === "object" && (doc as Record<string, unknown>).schema === 1 && Array.isArray((doc as Record<string, unknown>).operations);
}
function isOpenApi(doc: unknown): boolean {
  return !!doc && typeof doc === "object" && (typeof (doc as Record<string, unknown>).openapi === "string" || (doc as Record<string, unknown>).swagger === "2.0");
}

function fromDocument(doc: unknown, where: string, origin: Resolved["origin"]): Resolved {
  if (isDefinition(doc)) return { def: validateDefinition(doc), origin: "definition", detail: where };
  if (isOpenApi(doc)) {
    const { def, report } = ingestOpenApi(doc, where);
    return { def, report, origin, detail: where };
  }
  if (isHar(doc)) {
    const name = where.split(/[\\/]/).pop() ?? where;
    const { openapi, summary, notes } = harToOpenApi(doc, name);
    const { def, report } = ingestOpenApi(openapi);
    def.id = def.id || "recorded";
    def.source = { kind: "har", notes: `Generated locally from a recording (${name}). Field names and shapes only; no header values or text from the recording.` };
    def.notes = [`Built from ${summary.used} recorded requests to ${summary.host} (${summary.operations} operations).`, ...notes, ...(def.notes ?? [])];
    report.guesses.unshift(`Built from ${summary.used} of ${summary.entries} recorded requests to ${summary.host}.`, ...notes);
    return { def, report, origin: "har", detail: `${name} (recording of ${summary.host})` };
  }
  throw new Error(`${where} is not an OpenAPI/Swagger description or a Mock Anything twin definition.`);
}

/** Find a spec link on an HTML page (Swagger UI / Redoc / plain links). */
export function discoverSpecLink(html: string, base: string): string | null {
  const candidates: string[] = [];
  for (const m of html.matchAll(/(?:spec-url|data-url|url)\s*[:=]\s*["']([^"'<>]+?\.(?:json|ya?ml)(?:\?[^"'<>]*)?)["']/gi)) candidates.push(m[1]!);
  for (const m of html.matchAll(/href=["']([^"'<>]+?(?:openapi|swagger|api-docs|api-spec)[^"'<>]*?\.(?:json|ya?ml)(?:\?[^"'<>]*)?)["']/gi)) candidates.push(m[1]!);
  for (const c of candidates) {
    try { return new URL(c, base).toString(); } catch { /* next */ }
  }
  return null;
}

export async function resolveSource(input: string): Promise<Resolved> {
  const trimmed = input.trim();
  // 1. curated pack
  const pack = /^[a-z0-9._-]+$/i.test(trimmed) ? findPack(trimmed) : null;
  if (pack) return { def: pack, origin: "pack", detail: `${pack.title} pack` };

  // 2. local file
  const asPath = resolvePath(trimmed);
  if (existsSync(asPath) && statSync(asPath).isFile()) {
    if (statSync(asPath).size > MAX_SPEC) throw new Error(`${trimmed} is larger than ${MAX_SPEC} bytes`);
    return fromDocument(parseDocument(readFileSync(asPath, "utf8")), trimmed, "openapi-file");
  }

  // 3. URL
  if (/^https?:\/\//i.test(trimmed)) {
    const { text, contentType, finalUrl } = await fetchText(trimmed);
    const looksHtml = contentType.includes("html") || /^\s*</.test(text);
    if (looksHtml) {
      const link = discoverSpecLink(text, finalUrl);
      if (link) {
        const next = await fetchText(link);
        if (!/^\s*</.test(next.text)) return fromDocument(parseDocument(next.text), link, "openapi-url");
      }
      throw new DocsPageError(trimmed, text);
    }
    return fromDocument(parseDocument(text), trimmed, "openapi-url");
  }

  // 4. any API name → public directory
  if (/^[a-z0-9][a-z0-9 ._:-]{0,80}$/i.test(trimmed)) return resolveByName(trimmed);
  throw new Error(`Don't know how to load "${trimmed}". Pass a pack name, an API name, an OpenAPI file, or a URL.`);
}

interface DirEntry { preferred: string; versions: Record<string, { swaggerUrl?: string; info?: { title?: string } }> }

export async function resolveByName(name: string): Promise<Resolved> {
  const n = name.toLowerCase().replace(/\s+/g, "");
  let list: Record<string, DirEntry>;
  try {
    list = JSON.parse(await cachedText(DIRECTORY, DAY)) as Record<string, DirEntry>;
  } catch (e) {
    throw new Error(`"${name}" isn't a built-in pack, and the public API directory couldn't be reached (${(e as Error).message}). Pass an OpenAPI file or URL instead.`);
  }
  const scored: { key: string; score: number }[] = [];
  for (const key of Object.keys(list)) {
    const [provider = "", service = ""] = key.toLowerCase().split(":");
    const base = provider.split(".")[0] ?? provider;
    const full = service ? `${base}-${service}` : base;
    let score = -1;
    if (key.toLowerCase() === n || provider === n) score = service ? 10 : 0;
    else if (base === n) score = service ? (service === "api" ? 2 : 5 + service.length / 100) : 1;
    else if (full === n || `${base}:${service}` === n || `${base}${service}` === n) score = 3;
    if (score >= 0) scored.push({ key, score });
  }
  scored.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key));
  const pick = scored[0];
  if (!pick) {
    const near = Object.keys(list).filter((k) => k.toLowerCase().includes(n)).slice(0, 8);
    const packs = listPacks().map((p) => p.id);
    throw new Error(`No API called "${name}" in the built-in packs (${packs.join(", ")}) or the public API directory.${near.length ? ` Close matches: ${near.join(", ")}.` : ""} You can also pass an OpenAPI file or URL, or build a twin from docs with the MCP tool \`twin_from_docs\`.`);
  }
  const entry = list[pick.key]!;
  const v = entry.versions[entry.preferred];
  if (!v?.swaggerUrl) throw new Error(`The directory entry for ${pick.key} has no spec URL.`);
  const text = await cachedText(v.swaggerUrl, 7 * DAY);
  const r = fromDocument(parseDocument(text), v.swaggerUrl, "apis-guru");
  return { ...r, detail: `${v.info?.title ?? pick.key} (${pick.key}, from the public APIs.guru directory)`, alternatives: scored.slice(1, 8).map((s) => s.key) };
}
