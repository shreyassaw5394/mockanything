// Clicks every button and link on the site (desktop + phone) and reports any that are covered or do nothing.
//   node scripts/site-clicks.mjs [url]   (uses the same local Chrome + puppeteer-core as site-check.mjs)
const { default: puppeteer } = await import("/Users/shreyassawant/dea/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");
const url = process.argv[2] ?? "https://shipatmidnight.dev/mockanything";
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
for (const [w, h, name] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.goto(url, { waitUntil: "networkidle0" });
  for (let y = 0; y < 20000; y += 500) { await page.evaluate((v) => window.scrollTo(0, v), y); await new Promise((r) => setTimeout(r, 50)); }
  const n = await page.evaluate(() => { const els = [...document.querySelectorAll("a, button, summary, input")]; els.forEach((el, i) => el.setAttribute("data-probe", String(i))); return els.length; });
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; });
  const bad = [];
  for (let i = 0; i < n; i++) {
    const r = await page.evaluate((i) => {
      const el = document.querySelector(`[data-probe="${i}"]`);
      const cs = getComputedStyle(el);
      if (el.hidden || cs.display === "none" || cs.visibility === "hidden" || el.closest("details:not([open])") && el.tagName !== "SUMMARY") return null;
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return null;
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const label = (el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 45);
      const ok = top && (top === el || el.contains(top));
      return ok && cs.pointerEvents !== "none" ? null : `${el.tagName.toLowerCase()} "${label}" ← covered by ${top ? top.tagName.toLowerCase() + (top.className ? "." + String(top.className).replace(/\s+/g, ".") : "") : "nothing"}${cs.pointerEvents === "none" ? " (pointer-events none)" : ""}`;
    }, i);
    if (r) bad.push(r);
  }
  // click each control and see whether anything changes (state attribute, text, open, hash, clipboard)
  const dead = [];
  for (let i = 0; i < n; i++) {
    const info = await page.evaluate((i) => {
      const el = document.querySelector(`[data-probe="${i}"]`);
      const cs = getComputedStyle(el);
      if (el.hidden || cs.display === "none" || el.tagName === "INPUT" || (el.tagName === "A" && !el.getAttribute("href")?.startsWith("#"))) return null;
      if (el.closest("details:not([open])") && el.tagName !== "SUMMARY") return null;
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const snap = () => JSON.stringify([...document.querySelectorAll("[aria-checked],[aria-selected],[aria-pressed],[aria-expanded],details,[data-state],[data-copy],.top,.cmd-act,[hidden]")].map((x) => [x.getAttribute("aria-checked"), x.getAttribute("aria-selected"), x.getAttribute("aria-pressed"), x.open, x.dataset.state, x.className, x.textContent.slice(0, 30), x.hidden])) + location.hash + document.body.className;
      window.__before = snap();
      return { label: (el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 45), tag: el.tagName.toLowerCase() };
    }, i);
    if (!info) continue;
    const el = await page.$(`[data-probe="${i}"]`);
    try { await el.click({ delay: 20 }); } catch (e) { dead.push(`${info.tag} "${info.label}" click failed: ${e.message.slice(0, 60)}`); continue; }
    await new Promise((r) => setTimeout(r, 350));
    const changed = await page.evaluate(() => {
      const snap = () => JSON.stringify([...document.querySelectorAll("[aria-checked],[aria-selected],[aria-pressed],[aria-expanded],details,[data-state],[data-copy],.top,.cmd-act,[hidden]")].map((x) => [x.getAttribute("aria-checked"), x.getAttribute("aria-selected"), x.getAttribute("aria-pressed"), x.open, x.dataset.state, x.className, x.textContent.slice(0, 30), x.hidden])) + location.hash + document.body.className;
      return snap() !== window.__before;
    });
    if (!changed) dead.push(`${info.tag} "${info.label}" — click changed nothing`);
  }
  console.log(`\n== ${name}: ${n} clickable elements, ${bad.length} covered, ${dead.length} with no visible effect`);
  for (const d of dead) console.log("  · " + d);
  for (const b of bad) console.log("  ✗ " + b);
  await page.close();
}
await browser.close();
