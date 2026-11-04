// Local dashboard. Data is only ever inserted with textContent; the page holds no data itself and
// reads the control token from the URL fragment (never sent to the server in the page request).

export function dashboardHtml(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>Mock Anything</title>
<style>
:root { color-scheme: light dark; --bg:#fafaf9; --fg:#18181b; --muted:#71717a; --card:#fff; --line:#e4e4e7; --accent:#c2410c; --ok:#15803d; --bad:#b91c1c; --warn:#a16207; --code:#f4f4f5; }
@media (prefers-color-scheme: dark) { :root { --bg:#0c0c0e; --fg:#f4f4f5; --muted:#a1a1aa; --card:#151518; --line:#27272a; --accent:#ff7a45; --ok:#4ade80; --bad:#f87171; --warn:#facc15; --code:#1c1c20; } }
* { box-sizing:border-box; }
body { margin:0; font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
header { padding:16px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
header h1 { font-size:16px; margin:0; letter-spacing:-0.01em; }
header .meta { color:var(--muted); font-size:13px; display:flex; gap:16px; flex-wrap:wrap; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
nav { display:flex; gap:4px; padding:8px 16px; border-bottom:1px solid var(--line); overflow-x:auto; }
nav button { font:inherit; border:0; background:transparent; color:var(--muted); padding:6px 10px; border-radius:6px; cursor:pointer; white-space:nowrap; }
nav button[aria-selected="true"] { background:var(--code); color:var(--fg); font-weight:600; }
main { padding:16px; max-width:1200px; }
.list { border:1px solid var(--line); border-radius:10px; background:var(--card); overflow:hidden; }
.row { display:grid; grid-template-columns: 70px 1fr 64px 70px; gap:12px; padding:8px 12px; border-top:1px solid var(--line); cursor:pointer; align-items:center; }
.row:first-child { border-top:0; }
.row:hover { background:var(--code); }
.row .path { font-family: ui-monospace, Menlo, monospace; font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.s2 { color:var(--ok); } .s4, .s5 { color:var(--bad); } .muted { color:var(--muted); }
.tag { font-size:11px; padding:1px 6px; border-radius:99px; border:1px solid var(--line); margin-left:6px; color:var(--warn); }
pre { background:var(--code); padding:12px; border-radius:8px; overflow:auto; margin:8px 0; max-height:420px; }
.detail { padding:8px 12px 12px; border-top:1px dashed var(--line); }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:12px; }
.card { border:1px solid var(--line); border-radius:10px; background:var(--card); padding:14px; }
.card h3 { margin:0 0 6px; font-size:14px; }
button.act { font:inherit; padding:6px 10px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button.act:hover { border-color:var(--accent); }
input, select { font:inherit; padding:6px 8px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
.empty { padding:24px; text-align:center; color:var(--muted); }
.banner { padding:10px 16px; background:var(--code); border-bottom:1px solid var(--line); color:var(--warn); display:none; }
@media (max-width:600px) { .row { grid-template-columns: 56px 1fr 44px; } .row .dur { display:none; } }
</style></head><body>
<div class="banner" id="warn"></div>
<header><h1 id="title">Mock Anything</h1><div class="meta"><span>Base URL <code id="base"></code></span><span>Webhook secret <code id="secret">••••</code> <button class="act" id="reveal">Show</button></span><span id="src"></span></div></header>
<nav role="tablist">
<button role="tab" data-tab="requests" aria-selected="true">Requests</button>
<button role="tab" data-tab="webhooks" aria-selected="false">Webhooks</button>
<button role="tab" data-tab="state" aria-selected="false">State</button>
<button role="tab" data-tab="controls" aria-selected="false">Scenarios &amp; chaos</button>
<button role="tab" data-tab="about" aria-selected="false">Twin</button>
</nav>
<main id="main"></main>
<script nonce="${nonce}">
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
  const api = (p, body) => fetch("/__mockanything/api" + p, { method: body ? "POST" : "GET", headers: { "x-mockanything-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(String(k ?? ""))); return e; };
  const pre = (v) => el("pre", {}, JSON.stringify(v, null, 2));
  let tab = "requests", info = null, open = new Set();
  const main = document.getElementById("main");

  async function loadInfo() {
    info = await api("/info");
    if (info.error) { main.replaceChildren(el("div", { class: "empty" }, "Open the dashboard with the link printed in the terminal (it carries the access token).")); return false; }
    document.getElementById("title").textContent = info.title + " twin";
    document.getElementById("base").textContent = info.baseUrl;
    document.getElementById("src").textContent = info.inferred ? "Inferred from " + (info.source?.url || "a spec") : (info.source?.kind === "pack" ? "Curated pack" : "");
    const w = document.getElementById("warn");
    if (info.warnings?.length) { w.style.display = "block"; w.textContent = info.warnings.join(" "); }
    return true;
  }
  document.getElementById("reveal").addEventListener("click", (e) => { const s = document.getElementById("secret"); const shown = s.textContent !== "••••"; s.textContent = shown ? "••••" : (info?.webhookSecret || ""); e.target.textContent = shown ? "Show" : "Hide"; });

  async function render() {
    if (tab === "requests") {
      const rows = (await api("/requests")).slice().reverse();
      if (!rows.length) return main.replaceChildren(el("div", { class: "list" }, el("div", { class: "empty" }, "No requests yet. Point your app at " + (info?.baseUrl || "the base URL") + ".")));
      main.replaceChildren(el("div", { class: "list" }, ...rows.map(r => {
        const row = el("div", { class: "row", onclick: () => { open.has(r.id) ? open.delete(r.id) : open.add(r.id); render(); } },
          el("strong", {}, r.method), el("span", { class: "path" }, r.path, r.scenario ? el("span", { class: "tag" }, r.scenario) : "", r.chaos ? el("span", { class: "tag" }, "chaos: " + r.chaos) : "", r.warning ? el("span", { class: "tag" }, r.warning) : ""),
          el("span", { class: "s" + String(r.status)[0] }, r.status), el("span", { class: "muted dur" }, r.durationMs + " ms"));
        if (!open.has(r.id)) return row;
        return el("div", {}, row, el("div", { class: "detail" }, el("div", { class: "muted" }, "Request"), pre({ headers: r.requestHeaders, body: r.requestBody }), el("div", { class: "muted" }, "Response"), pre(r.responseBody)));
      })));
    } else if (tab === "webhooks") {
      const rows = (await api("/deliveries")).slice().reverse();
      const eps = info?.endpoints || [];
      const add = el("div", { class: "card" }, el("h3", {}, "Webhook endpoints"),
        eps.length ? el("div", {}, ...eps.map(e => el("div", {}, el("code", {}, e.url), " ", el("span", { class: "muted" }, e.events.join(", "))))) : el("div", { class: "muted" }, "None yet. Add one (localhost only):"),
        (() => { const i = el("input", { placeholder: "http://localhost:3000/webhooks", size: "36" }); return el("div", { style: "margin-top:8px;display:flex;gap:8px;flex-wrap:wrap" }, i, el("button", { class: "act", onclick: async () => { const r = await api("/webhooks", { url: i.value }); if (r.error) alert(r.error); await loadInfo(); render(); } }, "Add")); })());
      main.replaceChildren(add, el("div", { style: "height:12px" }), el("div", { class: "list" }, ...(rows.length ? rows.map(d => {
        const key = "d" + d.id + d.attempt + (d.duplicate ? "x" : "");
        const row = el("div", { class: "row", onclick: () => { open.has(key) ? open.delete(key) : open.add(key); render(); } },
          el("strong", {}, "POST"), el("span", { class: "path" }, d.type + " → " + d.url, d.duplicate ? el("span", { class: "tag" }, "duplicate") : "", d.attempt > 1 ? el("span", { class: "tag" }, "retry " + d.attempt) : ""),
          el("span", { class: d.status ? "s" + String(d.status)[0] : "s5" }, d.status ?? "failed"), el("span", { class: "muted dur" }, d.error ? "error" : ""));
        if (!open.has(key)) return row;
        return el("div", {}, row, el("div", { class: "detail" }, d.error ? el("div", { class: "muted" }, d.error) : "", pre(d.payload)));
      }) : [el("div", { class: "empty" }, "No webhooks sent yet.")])));
    } else if (tab === "state") {
      const state = await api("/state");
      main.replaceChildren(el("div", { style: "margin-bottom:12px" }, el("button", { class: "act", onclick: async () => { if (confirm("Clear all twin state?")) { await api("/reset", {}); render(); } } }, "Reset twin")),
        ...Object.entries(state).map(([name, items]) => el("div", { class: "card", style: "margin-bottom:12px" }, el("h3", {}, name + " (" + items.length + ")"), items.length ? pre(items) : el("div", { class: "muted" }, "Empty"))));
    } else if (tab === "controls") {
      const sc = info?.scenarios || [];
      const modes = ["timeout", "5xx", "slow", "429", "dup-webhooks", "out-of-order"];
      const checks = modes.map(m => { const c = el("input", { type: "checkbox", value: m }); if (info?.chaos?.modes?.includes(m)) c.checked = true; return el("label", { style: "margin-right:12px;white-space:nowrap" }, c, " " + m); });
      const rate = el("input", { type: "number", min: "0", max: "1", step: "0.05", value: String(info?.chaos?.rate ?? 0.15), style: "width:80px" });
      main.replaceChildren(el("div", { class: "grid" },
        el("div", { class: "card" }, el("h3", {}, "Chaos"), el("div", { class: "muted" }, info?.chaos ? "On, seed " + info.chaos.seed : "Off"), el("div", { style: "margin:8px 0" }, ...checks), el("div", {}, "Rate ", rate),
          el("div", { style: "margin-top:8px;display:flex;gap:8px" }, el("button", { class: "act", onclick: async () => { await api("/chaos", { modes: checks.map(l => l.firstChild).filter(c => c.checked).map(c => c.value), rate: Number(rate.value) }); await loadInfo(); render(); } }, "Apply"), el("button", { class: "act", onclick: async () => { await api("/chaos", { off: true }); await loadInfo(); render(); } }, "Turn off"))),
        ...sc.map(s => el("div", { class: "card" }, el("h3", {}, s.name), el("div", { class: "muted" }, s.on + " · " + s.trigger), el("p", {}, s.description), el("button", { class: "act", onclick: async () => { await api("/scenario", { name: s.name }); alert("The next " + s.on + " will use " + s.name + "."); } }, "Force next")))));
    } else {
      main.replaceChildren(el("div", { class: "grid" },
        el("div", { class: "card" }, el("h3", {}, "About this twin"), el("p", {}, info?.description || ""), ...(info?.notes || []).map(n => el("p", { class: "muted" }, n)), el("p", { class: "muted" }, "Mock Anything is not affiliated with any company it simulates.")),
        el("div", { class: "card" }, el("h3", {}, "Operations (" + (info?.operations?.length || 0) + ")"), pre(info?.operations || []))));
    }
  }

  document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", async () => { tab = b.dataset.tab; document.querySelectorAll("nav button").forEach(x => x.setAttribute("aria-selected", String(x === b))); await loadInfo(); render(); }));
  let pending = false;
  const refresh = () => { if (pending) return; pending = true; setTimeout(async () => { pending = false; if (tab === "webhooks" || tab === "controls") await loadInfo(); render(); }, 250); };
  // live updates: a streamed fetch, so the token travels in a header (EventSource can't send one)
  const stream = async () => {
    try {
      const r = await fetch("/__mockanything/api/stream", { headers: { "x-mockanything-token": token } });
      if (!r.ok || !r.body) throw new Error("stream");
      const reader = r.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; const text = new TextDecoder().decode(value); if (text.includes("event:") || text.includes("data:")) refresh(); }
    } catch {}
    setTimeout(stream, 2000);
  };
  loadInfo().then(ok => { if (!ok) return; render(); stream(); });
})();
</script></body></html>`;
}
