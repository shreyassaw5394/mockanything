import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SavedState } from "./twin.js";

const MAX_STATE = 50 * 1024 * 1024;

/** `~/.mockanything/state/<twin>.json` (or under MOCKANYTHING_HOME). */
export function defaultStatePath(twinId: string): string {
  const home = process.env.MOCKANYTHING_HOME ?? join(homedir(), ".mockanything");
  return join(home, "state", `${twinId.replace(/[^a-z0-9._-]/gi, "_")}.json`);
}

export function readState(path: string): SavedState | null {
  const p = resolve(path);
  if (!existsSync(p)) return null;
  const size = statSync(p).size;
  if (size > MAX_STATE) throw new Error(`State file ${path} is larger than ${MAX_STATE} bytes`);
  if (size === 0) return null;
  let v: unknown;
  try { v = JSON.parse(readFileSync(p, "utf8"), (k, x) => (k === "__proto__" || k === "constructor" ? undefined : x)); }
  catch { throw new Error(`State file ${path} is not valid JSON. Move it away or pick another --state file.`); }
  if (!v || typeof v !== "object" || (v as SavedState).mockanything !== 1) throw new Error(`${path} is not a Mock Anything state file.`);
  return v as SavedState;
}

/** Atomic write (temp file + rename), owner-only permissions. */
export function writeState(path: string, s: SavedState): void {
  const p = resolve(path);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, JSON.stringify(s)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, p);
}

/** True when the path sits inside a git work tree (state may hold test data you don't want committed). */
export function insideGitRepo(path: string): boolean {
  let dir = dirname(resolve(path));
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}
