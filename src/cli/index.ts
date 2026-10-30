import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { stringify as toYaml } from "yaml";
import { serveTwin, parseChaos, type RunningTwin } from "../engine/server.js";
import { applyOverrides, listPacks, loadDefinitionFile, parseDocument } from "../engine/load.js";
import { resolveSource, DocsPageError, type Resolved } from "../ingest/resolve.js";
import { VERSION } from "../version.js";
import { defaultStatePath, insideGitRepo } from "../engine/state.js";

const tty = process.stdout.isTTY;
const c = {
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[39m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[39m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[39m` : s),
};

const HELP = `Mock Anything ${VERSION}: a working twin of any API, on your machine.

Usage
  mockanything <api>                 start a twin (pack name, any API name, OpenAPI file or URL)
  mockanything list                  built-in packs
  mockanything inspect <api>         show what was inferred (as an editable definition)
  mockanything validate <file>       check a twin definition
  mockanything env <api>             config snippets for pointing your app at the twin
  mockanything verify <api>          measure how closely a twin matches the real API (your test key)
  mockanything mcp                   run the MCP server (for Claude Code, Cursor and other agents)

Examples
  mockanything stripe
  mockanything ./openapi.yaml --port 4020
  mockanything https://petstore3.swagger.io/api/v3/openapi.json
  mockanything slack --chaos --seed 42
  mockanything stripe --webhook http://localhost:3000/webhooks/stripe
  mockanything stripe --persist
  mockanything ./recording.har
  mockanything verify stripe --key sk_test_...

Options
  --port <n>                  port (default 4010; the next free one is used if busy)
  --webhook <url>             deliver webhooks here (repeatable; localhost only)
  --allow-webhook-host <h>    also allow webhook/callback URLs on this host (repeatable)
  --cors <origin>             allow browser calls from this origin (localhost origins are always allowed)
  --chaos[=modes]             inject failures: timeout,5xx,slow,429,dup-webhooks,out-of-order (default: all)
  --chaos-rate <0..1>         share of requests affected (default 0.15)
  --seed <n>                  make chaos repeatable
  --persist                   keep the twin's data between restarts (~/.mockanything/state/<twin>.json)
  --state <file>              same, in a file you choose
  --overrides <file>          YAML/JSON merged over the twin definition
  --json                      print startup info (or the verify report) as JSON

Verify options
  --key <test key>            your sandbox key (or MOCKANYTHING_SANDBOX_KEY). Live keys are refused.
  --suite <file>              your own suite (default: the built-in one for that twin)
  --against <url>             real API base URL (default: the suite's; required for twins without a suite)
  --out <file>                write the report (.md or .json; repeat for both)
  --pace <ms>                 time between calls to the real API (default 1000, minimum 200)
  -h, --help / -v, --version

Mock Anything is a free, non-commercial passion project. Not affiliated with any company it simulates.
Simulated responses only: nothing is sent to the real provider.`;

function fail(msg: string, code = 1): never {
  process.stderr.write(`${c.red("error")} ${msg}\n`);
  process.exit(code);
}

async function load(source: string, overrides?: string): Promise<Resolved> {
  try {
    const r = await resolveSource(source);
    if (overrides) r.def = applyOverrides(r.def, parseDocument(readFileSync(overrides, "utf8")));
    return r;
  } catch (e) {
    if (e instanceof DocsPageError) fail(e.message);
    fail((e as Error).message);
  }
}

function fill(snippet: string, t: { url: string; port: number; secret: string }): string {
  return snippet.replaceAll("{{baseUrl}}", t.url).replaceAll("{{port}}", String(t.port)).replaceAll("{{host}}", "localhost").replaceAll("{{secret}}", t.secret);
}

function genericSnippet(t: RunningTwin): string {
  return `Point your HTTP client or SDK's base URL at ${t.url}${t.twin.def.basePath ?? ""}`;
}

async function start(source: string, values: Record<string, unknown>): Promise<void> {
  const r = await load(source, values.overrides as string | undefined);
  const chaosFlag = values.chaos as string | boolean | undefined;
  const chaos = chaosFlag === undefined || chaosFlag === false ? null : parseChaos({
    modes: typeof chaosFlag === "string" && chaosFlag !== "" && chaosFlag !== "true" ? chaosFlag : undefined,
    rate: values["chaos-rate"], seed: values.seed,
  });
  const basePort = values.port ? Number(values.port) : 4010;
  if (!Number.isInteger(basePort) || basePort < 0 || basePort > 65535) fail("--port must be a number between 0 and 65535");
  const statePath = values.state ? String(values.state) : values.persist ? defaultStatePath(r.def.id) : undefined;
  let t: RunningTwin | null = null;
  let lastErr: unknown;
  for (let p = basePort; p < basePort + 20 && !t; p++) {
    try {
      t = await serveTwin(r.def, {
        port: basePort === 0 ? 0 : p, chaos,
        webhookUrls: values.webhook as string[] | undefined,
        allowWebhookHosts: values["allow-webhook-host"] as string[] | undefined,
        corsOrigins: values.cors as string[] | undefined,
        statePath,
      });
    } catch (e) {
      lastErr = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || basePort === 0) break;
    }
  }
  if (!t) fail(`Could not start: ${(lastErr as Error)?.message ?? "no free port"}`);

  if (values.json) {
    process.stdout.write(JSON.stringify({ id: r.def.id, title: r.def.title, origin: r.origin, url: t.url, dashboard: t.dashboardUrl, webhookSecret: t.twin.webhookSecret, token: t.token, state: t.state ?? null }) + "\n");
  } else {
    const label = r.origin === "pack" ? "curated pack" : r.report ? "inferred" : "definition";
    const lines = [
      "",
      `${c.bold("Mock Anything")} · ${r.def.title} twin ${c.dim(`(${label})`)}`,
      "",
      `  API             ${c.green(t.url + (r.def.basePath ?? ""))}`,
      `  Dashboard       ${t.dashboardUrl}`,
      r.def.webhooks ? `  Webhook secret  ${t.twin.webhookSecret}` : "",
      ...(t.twin.listEndpoints().map((e) => `  Webhooks →      ${e.url}`)),
      `  Chaos           ${chaos ? c.yellow(`on (${chaos.modes.join(", ")}, ${Math.round(chaos.rate * 100)}%, seed ${chaos.seed})`) : "off"}`,
      `  Source          ${r.detail}`,
      t.state ? `  Saved state     ${t.state.path} ${c.dim(t.state.restored ? `(${t.state.restored} objects restored${t.state.dropped ? `, ${t.state.dropped} dropped` : ""})` : "(new)")}` : "",
    ].filter(Boolean);
    if (t.state && values.state && insideGitRepo(t.state.path)) lines.push(c.yellow(`  ! ${t.state.path} is inside a git repo. Add it to .gitignore so test data isn't committed.`));
    if (r.report) lines.push(`  Inferred        ${r.report.resources.length} resources, ${r.report.operations.total} operations · ${c.dim("mockanything inspect " + source + " to see and override guesses")}`);
    if (r.alternatives?.length) lines.push(`  Also available  ${c.dim(r.alternatives.slice(0, 5).join(", "))}`);
    const snip = r.def.snippets?.node ? fill(r.def.snippets.node, { url: t.url, port: t.port, secret: t.twin.webhookSecret }) : genericSnippet(t);
    lines.push("", c.dim("  Use it:"), ...snip.trimEnd().split("\n").map((l) => `    ${l}`));
    for (const n of (r.def.notes ?? []).slice(0, 3)) lines.push(c.dim(`  · ${n}`));
    lines.push("", c.dim(`  Simulated responses only; nothing reaches ${r.def.title}. Not affiliated with any company it simulates. Ctrl+C to stop.`), "");
    process.stdout.write(lines.join("\n") + "\n");
  }

  const stop = async () => { await t!.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function verify(source: string, values: Record<string, unknown>): Promise<void> {
  const { autoSuite, loadSuite, reportMarkdown, runVerify, builtInSuites, assertTestKey } = await import("../verify/verify.js");
  const r = await load(source, values.overrides as string | undefined);
  const key = String(values.key ?? process.env.MOCKANYTHING_SANDBOX_KEY ?? "");
  let suite;
  try {
    if (values.suite) suite = loadSuite(String(values.suite));
    else if (builtInSuites().includes(r.def.id)) suite = loadSuite(r.def.id);
    else if (values.against) suite = autoSuite(r.def, String(values.against));
    else fail(`No built-in verify suite for ${r.def.title}. Pass --against <real base URL> to check its list calls, or --suite <file>.`);
  } catch (e) { fail((e as Error).message); }
  if (suite.twin !== r.def.id) fail(`That suite is for the "${suite.twin}" twin, not "${r.def.id}".`);
  try { assertTestKey(key, r.def, suite); } catch (e) { fail((e as Error).message); }
  const against = String(values.against ?? suite.realBaseUrl);
  if (!values.json) process.stdout.write(`${c.bold("Mock Anything verify")} · ${r.def.title} twin vs ${against}\n${c.dim(`  ${suite.steps.length} checks, about one call a second to the real API. Test-mode key only.`)}\n\n`);
  let report;
  try {
    report = await runVerify(r.def, suite, {
      key, against: values.against ? String(values.against) : undefined,
      paceMs: values.pace ? Number(values.pace) : undefined, maxCalls: values["max-calls"] ? Number(values["max-calls"]) : undefined,
      onStep: values.json ? undefined : (s) => {
        const mark = s.score >= 90 ? c.green("✓") : s.score >= 60 ? c.yellow("~") : c.red("✗");
        process.stdout.write(`  ${mark} ${s.name.padEnd(46)} ${String(s.status.twin ?? "err").padStart(3)} / ${String(s.status.real ?? "err").padStart(3)}  ${s.score}%\n`);
      },
    });
  } catch (e) { fail((e as Error).message); }
  const outs = ([] as unknown[]).concat(values.out ?? []).map(String);
  for (const out of outs) writeFileSync(out, out.endsWith(".json") ? JSON.stringify(report, null, 2) + "\n" : reportMarkdown(report));
  if (values.json) { process.stdout.write(JSON.stringify(report, null, 2) + "\n"); return; }
  const s = report.summary;
  process.stdout.write(`\n  ${c.bold(`Fidelity ${report.score}%`)}  ${c.dim(`status ${s.status}% · fields ${s.fields}% · types ${s.types}% · ids and codes ${s.values}%`)}\n`);
  const worst = report.steps.filter((x) => x.missing.length || x.typeDiffs.length || x.valueDiffs.length).slice(0, 5);
  for (const w of worst) {
    const bits = [...w.valueDiffs.slice(0, 2), ...w.typeDiffs.slice(0, 2), ...(w.missing.length ? [`missing ${w.missing.slice(0, 4).join(", ")}${w.missing.length > 4 ? ` +${w.missing.length - 4}` : ""}`] : [])];
    process.stdout.write(c.dim(`  · ${w.name}: ${bits.join("; ")}\n`));
  }
  process.stdout.write(`\n${outs.length ? `  Report: ${outs.join(", ")}\n` : c.dim("  Add --out report.md for the full list of differences.\n")}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string" },
      webhook: { type: "string", multiple: true },
      "allow-webhook-host": { type: "string", multiple: true },
      cors: { type: "string", multiple: true },
      chaos: { type: "string" },
      "chaos-rate": { type: "string" },
      seed: { type: "string" },
      overrides: { type: "string" },
      persist: { type: "boolean" },
      state: { type: "string" },
      key: { type: "string" },
      suite: { type: "string" },
      against: { type: "string" },
      pace: { type: "string" },
      "max-calls": { type: "string" },
      out: { type: "string", multiple: true },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  // `--chaos` with no value
  if (argv.includes("--chaos")) (values as Record<string, unknown>).chaos = true;

  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  const [cmd, arg] = positionals;
  if (values.help || !cmd || cmd === "help") { process.stdout.write(HELP + "\n"); return; }

  switch (cmd) {
    case "list": {
      const packs = listPacks();
      process.stdout.write(`${c.bold("Built-in packs")} (hand-tuned twins)\n`);
      for (const p of packs) {
        const f = p.fidelity ? c.green(`${p.fidelity.score}% match`) + c.dim(` (${p.fidelity.measuredAt.slice(0, 10)})`) : c.dim("not measured yet");
        process.stdout.write(`  ${p.id.padEnd(12)} ${f}\n  ${"".padEnd(12)} ${c.dim(p.description ?? p.title)}\n`);
      }
      process.stdout.write(c.dim(`\nMatch scores come from \`mockanything verify\` against each provider's sandbox.\n`));
      process.stdout.write(`\nAny other API works too: ${c.bold("mockanything <name>")} looks it up in the public APIs.guru directory,\nor pass an OpenAPI file or URL.\n`);
      return;
    }
    case "inspect": {
      if (!arg) fail("usage: mockanything inspect <api> [--out twin.yaml]");
      const r = await load(arg, values.overrides);
      const yaml = toYaml(r.def, { lineWidth: 120 });
      const out = values.out?.[0];
      if (out) { writeFileSync(out, yaml); process.stdout.write(`Wrote ${out}. Edit it, then: mockanything ${out}\n`); }
      else process.stdout.write(yaml);
      if (r.report) {
        process.stderr.write(`\n${c.bold("Inference report")}\n  ${r.report.resources.length} resources, ${r.report.operations.total} operations ${c.dim(JSON.stringify(r.report.operations.byAction))}\n  auth ${r.report.auth} · lists ${r.report.listStyle} · ${r.report.webhooks} webhook bindings\n`);
        for (const res of r.report.resources.filter((x) => x.lifecycle || x.transitions.length).slice(0, 30)) {
          process.stderr.write(`  ${res.name}: ${res.lifecycle ?? "no state field"}${res.transitions.length ? ` · ${res.transitions.join(", ")}` : ""}\n`);
        }
        for (const g of r.report.guesses.slice(0, 20)) process.stderr.write(c.dim(`  · ${g}\n`));
      }
      return;
    }
    case "validate": {
      if (!arg) fail("usage: mockanything validate <file>");
      try { const d = loadDefinitionFile(arg); process.stdout.write(`${c.green("valid")} ${d.title}: ${Object.keys(d.resources).length} resources, ${d.operations.length} operations\n`); }
      catch (e) { fail((e as Error).message); }
      return;
    }
    case "env": {
      if (!arg) fail("usage: mockanything env <api> [--port 4010]");
      const r = await load(arg);
      const port = Number(values.port ?? 4010);
      const t = { url: `http://localhost:${port}`, port, secret: "<printed when the twin starts>" };
      const snippets = r.def.snippets ?? {};
      if (!Object.keys(snippets).length) { process.stdout.write(`Point your HTTP client or SDK's base URL at ${t.url}${r.def.basePath ?? ""}\n`); return; }
      for (const [lang, s] of Object.entries(snippets)) process.stdout.write(`${c.bold(lang)}\n${fill(s, t)}\n`);
      return;
    }
    case "verify": {
      if (!arg) fail("usage: mockanything verify <api> --key <test key> [--suite file] [--against url] [--out report.md]");
      await verify(arg, values as Record<string, unknown>);
      return;
    }
    case "mcp": {
      const { runMcp } = await import("../mcp/server.js");
      await runMcp();
      return;
    }
    default:
      await start(cmd, values as Record<string, unknown>);
  }
}

main().catch((e) => fail((e as Error).message));
