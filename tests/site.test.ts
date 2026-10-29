import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../site/", import.meta.url).pathname;
const pages = readdirSync(root).filter((f) => f.endsWith(".html"));
const read = (f: string) => readFileSync(join(root, f), "utf8");
const vercel = JSON.parse(read("vercel.json")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };

const resolveLocal = (href: string): boolean => {
  const path = href.split(/[?#]/)[0]!;
  if (path === "/" || path === "") return existsSync(join(root, "index.html"));
  const p = join(root, path);
  return existsSync(p) || existsSync(`${p}.html`);
};

describe("website", () => {
  it("has the pages it links to", () => {
    expect(pages).toEqual(expect.arrayContaining(["index.html", "privacy.html", "terms.html", "404.html"]));
    for (const f of ["styles.css", "site.js", "favicon.svg", "og.png", "license.txt", "notice.txt", "fonts/Archivo-var.woff2", "fonts/IBMPlexMono-400.woff2", "fonts/IBMPlexMono-500.woff2", "fonts/OFL-Archivo.txt", "fonts/OFL-IBMPlexMono.txt"]) expect(existsSync(join(root, f)), f).toBe(true);
  });

  for (const page of pages) {
    describe(page, () => {
      const html = read(page);
      it("loads nothing from other sites and has no inline scripts or styles", () => {
        const assets = [...html.matchAll(/<(?:script|link|img|source|iframe|video|audio)\b[^>]*?(?:src|href)="([^"]+)"[^>]*>/g)]
          .filter((m) => !/rel="canonical"/.test(m[0]))
          .map((m) => m[1]!);
        for (const c of [...html.matchAll(/rel="canonical" href="([^"]+)"/g)]) expect(c[1]!.startsWith("https://mockanything.dev/")).toBe(true);
        for (const a of assets) expect(a.startsWith("/"), `${page}: ${a}`).toBe(true);
        expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
        expect(html).not.toMatch(/\sstyle="/);
        expect(html).not.toMatch(/\son[a-z]+="/);
        expect(html).not.toMatch(/googleapis|gstatic|googletagmanager|google-analytics|posthog|segment|hotjar|facebook\.net|doubleclick/i);
      });
      it("only links to pages that exist (or mail)", () => {
        const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
        for (const l of links) {
          if (l.startsWith("#") || l.startsWith("mailto:")) continue;
          if (/^https?:/.test(l)) {
            // outbound links allowed only on legal pages (provider policies)
            expect(["privacy.html", "terms.html"], `${page}: ${l}`).toContain(page);
            expect(l).not.toMatch(/github\.com\/shreyassaw5394\/mockanything/); // private until launch
            continue;
          }
          expect(resolveLocal(l), `${page}: ${l}`).toBe(true);
        }
        for (const id of [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!)) expect(html, `#${id}`).toContain(`id="${id}"`);
      });
      if (page !== "404.html") {
        it("has a title, description, the passion-project and trademark notice, and legal links", () => {
          expect(html).toMatch(/<title>[^<]+<\/title>/);
          expect(html).toMatch(/<meta name="description" content="[^"]{40,}"/);
          expect(html).toContain("free, non-commercial passion project");
          expect(html).toContain("not affiliated with");
          expect(html).toContain('href="/privacy"');
          expect(html).toContain('href="/terms"');
        });
      }
    });
  }

  it("never makes absolute claims or names providers we haven't cleared", () => {
    const all = pages.map(read).join("\n");
    expect(all).not.toMatch(/\b(guaranteed|100% accurate|perfect fidelity|official (stripe|twilio|github|paystack|resend))\b/i);
    expect(all).not.toMatch(/razorpay|m-pesa|safaricom/i);
  });

  it("ships strict security headers", () => {
    const h = Object.fromEntries(vercel.headers.find((x) => x.source === "/(.*)")!.headers.map((x) => [x.key, x.value]));
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=\d{8}/);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBeTruthy();
    expect(h["Permissions-Policy"]).toContain("camera=()");
    const csp = h["Content-Security-Policy"]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("site script makes no network requests and uses no storage or cookies", () => {
    const js = read("site.js");
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|document\.cookie|eval\(|new Function/);
  });

  it("privacy policy matches what the tool does", () => {
    const p = read("privacy.html");
    for (const s of ["No cookies", "no analytics", "Vercel", "api.apis.guru", "no telemetry", "30 days", "do not sell or share", "16"]) expect(p.toLowerCase()).toContain(s.toLowerCase());
  });
});
