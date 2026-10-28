// A neutral test page for redirect flows. It must never resemble any provider's real checkout:
// no logos, no provider colours, and a permanent banner saying it is not a real payment.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f6f4; --fg:#1b1b1b; --muted:#666; --card:#fff; --line:#ddd; --warn:#7a3e00; --warnbg:#fff3d6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --fg:#eee; --muted:#aaa; --card:#1e1e1e; --line:#333; --warn:#ffd28a; --warnbg:#3a2a10; } }
  * { box-sizing: border-box; }
  body { margin:0; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
  .banner { background:var(--warnbg); color:var(--warn); padding:12px 16px; text-align:center; font-weight:600; border-bottom:1px solid var(--line); }
  main { max-width:440px; margin:40px auto; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .muted { color:var(--muted); font-size:13px; }
  .amount { font-size:28px; font-weight:700; margin:16px 0; font-variant-numeric: tabular-nums; }
  .row { display:flex; gap:12px; margin-top:20px; flex-wrap:wrap; }
  button { flex:1; min-width:140px; font:inherit; font-weight:600; padding:12px 16px; border-radius:8px; border:1px solid var(--line); cursor:pointer; background:var(--fg); color:var(--bg); }
  button.secondary { background:transparent; color:var(--fg); }
  footer { margin-top:16px; }
`;

export function checkoutPage(nonce: string, o: { title: string; amount?: string; twinTitle: string; action: string; nonce: string; canFail: boolean }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>Mock Anything test page</title><style>${STYLE}</style></head><body>
<div class="banner" role="alert">Mock Anything test page. Not a real payment. Never enter real card details.</div>
<main><div class="card">
<h1>${esc(o.title)}</h1>
<div class="muted">Simulated by a local ${esc(o.twinTitle)} twin. Nothing here is processed or sent anywhere.</div>
${o.amount ? `<div class="amount">${esc(o.amount)}</div>` : ""}
<div class="row">
<form method="post" action="${esc(o.action)}/succeed" style="flex:1;display:flex"><input type="hidden" name="nonce" value="${esc(o.nonce)}"><button type="submit">Approve (test)</button></form>
${o.canFail ? `<form method="post" action="${esc(o.action)}/fail" style="flex:1;display:flex"><input type="hidden" name="nonce" value="${esc(o.nonce)}"><button class="secondary" type="submit">Decline (test)</button></form>` : ""}
</div>
<footer class="muted">Mock Anything is not affiliated with any company it simulates.</footer>
</div></main><script nonce="${esc(nonce)}"></script></body></html>`;
}

export function donePage(nonce: string, title: string, message: string, link: string | undefined): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>Mock Anything test page</title><style>${STYLE}</style></head><body>
<div class="banner" role="alert">Mock Anything test page. Not a real payment.</div>
<main><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p>${link ? `<p><a href="${esc(link)}">Return to the app</a></p>` : `<p class="muted">You can close this tab.</p>`}</div></main>
<script nonce="${esc(nonce)}"></script></body></html>`;
}
