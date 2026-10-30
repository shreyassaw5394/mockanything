import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the real CLI (through tsx) the way an agent following the skill would.
const home = mkdtempSync(join(tmpdir(), "mockanything-cli-"));
const env = { ...process.env, MOCKANYTHING_HOME: home, NO_COLOR: "1" };
const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], { env, encoding: "utf8", timeout: 30_000 });
let child: ChildProcess;
let info: { url: string; id: string };

beforeAll(async () => {
  child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", "stripe", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
  info = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => { buf += d; const line = buf.split("\n").find((l) => l.startsWith("{")); if (line) resolve(JSON.parse(line)); });
    child.on("exit", (code) => reject(new Error(`twin exited ${code}`)));
    setTimeout(() => reject(new Error("twin did not start")), 20_000);
  });
});
afterAll(() => { child?.kill("SIGINT"); });

const call = (path: string, body?: Record<string, string>) => fetch(`${info.url}${path}`, {
  method: body ? "POST" : "GET",
  headers: { authorization: "Bearer sk_test_cli", "content-type": "application/x-www-form-urlencoded" },
  body: body ? new URLSearchParams(body).toString() : undefined,
});

describe("driving a running twin from the shell", () => {
  it("finds it, with an owner-only registry file that holds the token", () => {
    const r = cli("running", "--json");
    expect(r.status).toBe(0);
    const list = JSON.parse(r.stdout) as { id: string; url: string; token?: string }[];
    expect(list.map((x) => x.id)).toEqual(["stripe"]);
    expect(list[0]!.token).toBeUndefined();
    const dir = join(home, "running");
    const f = readdirSync(dir)[0]!;
    expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
  });

  it("forces a scenario, shows events and state, toggles chaos, moves the clock and resets", async () => {
    expect(cli("scenario").stdout).toContain("card_declined");
    expect(cli("scenario", "card_declined").status).toBe(0);
    const declined = await call("/v1/payment_intents", { amount: "500", currency: "usd", payment_method: "pm_card_visa", confirm: "true" });
    expect(declined.status).toBe(402);
    await call("/v1/customers", { email: "cli@example.com" });

    const ev = cli("events", "--json");
    const events = JSON.parse(ev.stdout) as { requests: { status: number; scenario?: string }[] };
    expect(events.requests.map((r) => r.status)).toEqual([402, 200]);
    expect(events.requests[0]!.scenario).toBe("card_declined");
    expect(ev.stdout).not.toContain("sk_test_cli");

    expect(JSON.stringify(JSON.parse(cli("state").stdout))).toContain("cli@example.com");

    expect(cli("chaos", "5xx", "--chaos-rate", "1").stdout).toContain("Chaos on: 5xx");
    expect((await call("/v1/customers")).status).toBeGreaterThanOrEqual(500);
    expect(cli("chaos", "off").stdout).toContain("Chaos off");
    expect((await call("/v1/customers")).status).toBe(200);

    const before = Date.now();
    const clock = cli("clock", "3d").stdout.match(/now (\S+)\./)![1]!;
    expect(new Date(clock).getTime() - before).toBeGreaterThan(3 * 86_400_000 - 60_000);
    expect(cli("clock", "soon").status).toBe(1);

    expect(cli("reset").status).toBe(0);
    expect(JSON.parse(cli("state").stdout).customers).toEqual([]);
  });

  it("prints the definition guide", () => {
    const r = cli("guide");
    expect(r.stdout).toContain("npx mockanything validate twin.json");
  });

  it("explains when no twin answers on a port", () => {
    const r = cli("events", "--port", "1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No twin is running on port 1");
  });
});
