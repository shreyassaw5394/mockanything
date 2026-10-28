import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateDefinition } from "./schema.js";
import type { TwinDefinition } from "./types.js";

const MAX_FILE = 50 * 1024 * 1024;

export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try { if (JSON.parse(readFileSync(pj, "utf8")).name === "mockanything") return dir; } catch { /* keep walking */ }
    }
    dir = dirname(dir);
  }
  throw new Error("Could not find the mockanything package root");
}

export function packsDir(): string { return join(packageRoot(), "packs"); }

/** Parse YAML or JSON text safely (core schema, no custom tags, bounded aliases). */
export function parseDocument(text: string): unknown {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(text, (k, v) => (k === "__proto__" || k === "constructor" ? undefined : v));
  return parseYaml(text, { schema: "core", customTags: [], maxAliasCount: 200, uniqueKeys: true, prettyErrors: true });
}

export function listPacks(): { id: string; title: string; description?: string }[] {
  const dir = packsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(ya?ml|json)$/.test(f))
    .map((f) => {
      const def = loadDefinitionFile(join(dir, f));
      return { id: def.id, title: def.title, description: def.description };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function findPack(name: string): TwinDefinition | null {
  const id = name.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!id) return null;
  for (const ext of ["yaml", "yml", "json"]) {
    const p = join(packsDir(), `${id}.${ext}`);
    if (existsSync(p)) return loadDefinitionFile(p);
  }
  return null;
}

export function loadDefinitionFile(path: string): TwinDefinition {
  const full = resolve(path);
  const size = statSync(full).size;
  if (size > MAX_FILE) throw new Error(`File too large (${size} bytes)`);
  return validateDefinition(parseDocument(readFileSync(full, "utf8")));
}

/** Apply a user's overrides file on top of a definition (deep merge; arrays replace). */
export function applyOverrides(def: TwinDefinition, overrides: unknown): TwinDefinition {
  const merged = deepMerge(def as unknown as Record<string, unknown>, overrides as Record<string, unknown>);
  return validateDefinition(merged);
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  if (!b || typeof b !== "object" || Array.isArray(b)) return a;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
      ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
      : v;
  }
  return out;
}
