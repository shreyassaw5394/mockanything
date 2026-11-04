import type { Condition, Json, Template } from "./types.js";

/**
 * A deliberately tiny expression language: path lookups, literals, `??` fallbacks and a fixed set of
 * functions supplied by the engine. There is no eval and no way to call anything not in `fns`.
 */
export interface EvalContext {
  [key: string]: unknown;
  fns?: Record<string, (...args: Json[]) => Json>;
}

const BLOCKED = new Set(["__proto__", "prototype", "constructor"]);
const MAX_EXPR = 300;

export function lookupPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const raw of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    // support `items[0]`
    const parts = raw.split(/[[\]]/).filter(Boolean);
    for (const part of parts) {
      if (BLOCKED.has(part)) return undefined;
      if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

function parseLiteral(tok: string): { ok: true; value: Json } | { ok: false } {
  if (/^-?\d+(\.\d+)?$/.test(tok)) return { ok: true, value: Number(tok) };
  if (tok === "true") return { ok: true, value: true };
  if (tok === "false") return { ok: true, value: false };
  if (tok === "null") return { ok: true, value: null };
  const q = tok.match(/^'(.*)'$/s) ?? tok.match(/^"(.*)"$/s);
  if (q) return { ok: true, value: q[1] ?? "" };
  return { ok: false };
}

function splitTop(s: string, sep: "," | "??"): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && sep === "," && ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    if (depth === 0 && sep === "??" && ch === "?" && s[i + 1] === "?") { out.push(cur.trim()); cur = ""; i++; continue; }
    cur += ch;
  }
  if (sep === "??" || cur.trim()) out.push(cur.trim());
  return out;
}
const splitArgs = (s: string) => splitTop(s, ",");
const splitFallback = (s: string) => splitTop(s, "??");

function evalTerm(term: string, ctx: EvalContext): unknown {
  const lit = parseLiteral(term);
  if (lit.ok) return lit.value;
  const call = term.match(/^([a-zA-Z_][\w]*)\((.*)\)$/s);
  if (call) {
    const fn = ctx.fns?.[call[1]!];
    if (!fn || !Object.prototype.hasOwnProperty.call(ctx.fns, call[1]!)) return undefined;
    const args = splitArgs(call[2] ?? "").map((a) => evalExpr(a, ctx) as Json);
    return fn(...args);
  }
  if (!/^[$\w][\w$.[\]-]*$/.test(term)) return undefined;
  return lookupPath(ctx, term);
}

export function evalExpr(expr: string, ctx: EvalContext): unknown {
  if (expr.length > MAX_EXPR) return undefined;
  for (const term of splitFallback(expr)) {
    const v = evalTerm(term, ctx);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  // last term may legitimately be null/"" — return it
  const terms = splitFallback(expr);
  return evalTerm(terms[terms.length - 1] ?? "", ctx);
}

const WHOLE = /^\{\{\s*([\s\S]+?)\s*\}\}$/;
const PART = /\{\{\s*([\s\S]+?)\s*\}\}/g;

export function renderString(s: string, ctx: EvalContext): unknown {
  const whole = s.match(WHOLE);
  if (whole && !whole[1]!.includes("}}")) return evalExpr(whole[1]!, ctx);
  if (!s.includes("{{")) return s;
  return s.replace(PART, (_m, e: string) => {
    const v = evalExpr(e, ctx);
    if (v === undefined || v === null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** Render a template. Undefined values become null so response shapes stay stable. */
export function render(t: Template | undefined, ctx: EvalContext): Json {
  if (t === undefined) return null;
  if (typeof t === "string") return toJson(renderString(t, ctx));
  if (Array.isArray(t)) return t.map((x) => render(x, ctx));
  if (t && typeof t === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(t)) {
      if (BLOCKED.has(k)) continue;
      out[k] = render(v, ctx);
    }
    return out;
  }
  return t;
}

function toJson(v: unknown): Json {
  if (v === undefined) return null;
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "object") return v as Json;
  return String(v);
}

function truthy(v: unknown): boolean {
  if (v === "false" || v === "0" || v === "") return false;
  return Boolean(v);
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b);
}

const regexCache = new Map<string, RegExp | null>();
export function safeRegex(src: string): RegExp | null {
  if (regexCache.has(src)) return regexCache.get(src)!;
  let re: RegExp | null = null;
  // Refuse patterns that can backtrack catastrophically: nested quantifiers like (a+)+,
  // repeated alternations like (a|aa)+, and backreferences.
  if (src.length <= 200 && !/\([^)]*[+*|][^)]*\)[+*{]/.test(src) && !/\\[1-9k]/.test(src)) {
    try { re = new RegExp(src); } catch { re = null; }
  }
  regexCache.set(src, re);
  return re;
}

/** Test a definition-supplied pattern against a bounded input; refused patterns never match. */
export function safeMatch(src: string, s: string): boolean {
  const re = safeRegex(src);
  return !!re && s.length <= MAX_MATCH_INPUT && re.test(s);
}
const MAX_MATCH_INPUT = 10_000;

export function evalCondition(c: Condition | undefined, ctx: EvalContext): boolean {
  if (!c) return true;
  if ("all" in c) return c.all.every((x) => evalCondition(x, ctx));
  if ("any" in c) return c.any.some((x) => evalCondition(x, ctx));
  if ("not" in c) return !evalCondition(c.not, ctx);
  const v = c.path.includes("{{") ? renderString(c.path, ctx) : evalExpr(c.path, ctx);
  if (c.exists !== undefined) return (v !== undefined && v !== null && v !== "") === c.exists;
  if (c.truthy !== undefined) return truthy(v) === c.truthy;
  if (c.equals !== undefined) return looseEquals(v, c.equals);
  if (c.in) return c.in.some((x) => looseEquals(v, x));
  if (c.matches) return typeof v === "string" && safeMatch(c.matches, v);
  if (c.lte !== undefined) { const o = evalExpr(c.lte, ctx); return Number(v) <= Number(o); }
  if (c.gte !== undefined) { const o = evalExpr(c.gte, ctx); return Number(v) >= Number(o); }
  return truthy(v);
}
