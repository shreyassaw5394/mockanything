// Serve site/ with the same headers as production (from site/vercel.json) and check it in headless Chrome:
// console errors, CSP violations, requests to other hosts, horizontal overflow, broken links, screenshots.
//
//   node scripts/site-check.mjs [outDir] [--url https://shipatmidnight.dev/mockanything]
//
// Needs Chrome (CHROME_PATH or the default macOS location) and puppeteer-core (PUPPETEER_CORE path or installed).
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const remote = urlIdx >= 0 ? args[urlIdx + 1] : null;
const out = resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--url") ?? "site-check-out");
mkdirSync(out, { recursive: true });
const root = resolve("site");
const cfg = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".json": "application/json" };

const globalHeaders = cfg.headers.find((h) => h.source === "/(.*)").headers;
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  let file = join(root, p);
  if (!file.startsWith(root)) { res.writeHead(400).end(); return; }
  if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
  const headers = Object.fromEntries(globalHeaders.filter((h) => h.key !== "Strict-Transport-Security" && !h.value.includes("upgrade-insecure")).map((h) => [h.key, h.key === "Content-Security-Policy" ? h.value.replace("; upgrade-insecure-requests", "") : h.value]));
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { ...headers, "content-type": TYPES[".html"] }).end(readFileSync(join(root, "404.html")));
    return;
  }
  res.writeHead(200, { ...headers, "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = remote ?? `http://localhost:${server.address().port}`;
const host = new URL(base).host;

const pc = process.env.PUPPETEER_CORE ?? "/Users/shreyassawant/dea/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
const { default: puppeteer } = await import(pc);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });

const problems = [];
const pages = ["/", "/privacy", "/terms", "/nope-404"];
for (const [w, h, label] of [[1280, 800, "desktop"], [390, 844, "phone"]]) {
  for (const reduced of [false, true]) {
    for (const path of pages) {
      if (reduced && path !== "/") continue;
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      if (reduced) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      page.on("console", (m) => { if ((m.type() === "error" && !(path === "/nope-404" && m.text().includes("404"))) || m.text().includes("Content Security Policy")) problems.push(`${label}${reduced ? " reduced" : ""} ${path}: console: ${m.text()}`); });
      page.on("pageerror", (e) => problems.push(`${label} ${path}: page error: ${e}`));
      page.on("request", (r) => { const u = new URL(r.url()); if (u.protocol.startsWith("http") && u.host !== host) problems.push(`${label} ${path}: request to other host: ${r.url()}`); });
      page.on("requestfailed", (r) => problems.push(`${label} ${path}: failed: ${r.url()}`));
      page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("nope-404")) problems.push(`${label} ${path}: HTTP ${r.status()} ${r.url()}`); });
      await page.goto(base + path, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 900));
      const cookies = await page.cookies();
      if (cookies.length) problems.push(`${label} ${path}: cookies set: ${cookies.map((c) => c.name).join(",")}`);
      const storage = await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length);
      if (storage) problems.push(`${label} ${path}: web storage used`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`${label} ${path}: horizontal overflow ${overflow}px`);
      const name = `${label}${reduced ? "-reduced" : ""}${path.replace(/\//g, "_") || "_home"}`;
      if (path === "/") {
        // scroll through so reveals and the demo run, screenshotting each section
        const ids = await page.evaluate(() => [...document.querySelectorAll("main > section")].map((s, i) => s.id || `s${i}`));
        for (const id of ids) {
          await page.evaluate((id) => (document.getElementById(id) ?? document.querySelectorAll("main > section")[Number(id.slice(1))]).scrollIntoView(), id);
          await new Promise((r) => setTimeout(r, id === "twin" ? 9000 : 1300));
          await page.screenshot({ path: join(out, `${name}-${id}.png`) });
        }
        // links
        const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
        for (const l of new Set(links)) {
          if (l.startsWith("#")) { if (!(await page.$(l))) problems.push(`missing anchor ${l}`); continue; }
          if (l.startsWith("mailto:")) continue;
          const u = new URL(l, base);
          if (u.host !== host) { problems.push(`external link on home page: ${l}`); continue; }
          const r = await fetch(u);
          if (!r.ok) problems.push(`broken link ${l} → ${r.status}`);
        }
      } else {
        await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
      }
      await page.close();
    }
  }
}
await browser.close();
server.close();
console.log(problems.length ? `PROBLEMS (${problems.length}):\n  ${[...new Set(problems)].join("\n  ")}` : "OK: no console errors, CSP violations, other-host requests, cookies, storage, overflow or broken links");
console.log(`screenshots: ${out}`);
process.exit(problems.length ? 1 : 0);
