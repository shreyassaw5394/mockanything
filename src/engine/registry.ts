import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Running twins on this machine, so `mockanything events` etc. can find them. Owner-only files (they hold the control token). */
export interface RunningEntry { port: number; url: string; token: string; id: string; title: string; basePath: string; pid: number; startedAt: string }

function dir(): string {
  const d = join(process.env.MOCKANYTHING_HOME ?? join(homedir(), ".mockanything"), "running");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try { chmodSync(d, 0o700); } catch { /* best effort */ }
  return d;
}

export function register(e: RunningEntry): () => void {
  const p = join(dir(), `${e.port}.json`);
  writeFileSync(p, JSON.stringify(e), { mode: 0o600 });
  let done = false;
  return () => { if (done) return; done = true; try { if (existsSync(p) && (JSON.parse(readFileSync(p, "utf8")) as RunningEntry).pid === e.pid) rmSync(p); } catch { /* already gone */ } };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Twins whose process is still running (stale entries are removed). */
export function listRunning(): RunningEntry[] {
  const out: RunningEntry[] = [];
  for (const f of readdirSync(dir()).filter((x) => /^\d+\.json$/.test(x))) {
    const p = join(dir(), f);
    try {
      const e = JSON.parse(readFileSync(p, "utf8")) as RunningEntry;
      if (alive(e.pid)) out.push(e); else rmSync(p);
    } catch { try { rmSync(p); } catch { /* ignore */ } }
  }
  return out.sort((a, b) => a.port - b.port);
}

export function findRunning(port?: number): RunningEntry {
  const all = listRunning();
  if (port) {
    const e = all.find((x) => x.port === port);
    if (!e) throw new Error(`No twin is running on port ${port}.${all.length ? ` Running: ${all.map((x) => `${x.id} on ${x.port}`).join(", ")}.` : ""}`);
    return e;
  }
  if (all.length === 1) return all[0]!;
  if (!all.length) throw new Error("No twin is running. Start one: mockanything <api>");
  throw new Error(`Several twins are running (${all.map((x) => `${x.id} on ${x.port}`).join(", ")}). Pick one with --port.`);
}

/** Call a running twin's control API. */
export async function control(e: RunningEntry, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${e.url}/__mockanything/api${path}`, {
    method, headers: { "x-mockanything-token": e.token, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(10_000),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((v as { error?: string }).error ?? `HTTP ${res.status}`);
  return v;
}
